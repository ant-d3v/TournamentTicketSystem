import { readCsv, requireColumns, writeCsv } from "./csv.ts";

const HELP = `Creates the league matchups from teams_export.csv (written by main.ts).

Every player plays one player from each other team: 15 games,
3 against each pot (own pot included). Teammates never meet.

Teams are paired in 15 rounds (every team meets one other team per round).
Each round has its own pot pattern: one pot plays the same pot,
the other four are swapped in two pairs (for example 1-2, 3-4, 5-5).
Rounds are only a way to build the pairs. Games can be played in any order.

Writes matchups.csv (player 1,score 1,player 2,score 2) with empty scores,
40 rows per round.

Usage:
  node matchups.ts       create the matchups
  node matchups.ts -h    show this help`;

if (process.argv[2] === "-h" || process.argv[2] === "--help") { console.log(HELP); process.exit(0); }

const POTS = [1, 2, 3, 4, 5];

// ---------- Input ----------

// teams_export.csv: team,pot 1,...,pot 5 with player names. The team order is already random
const teamRows = readCsv("teams_export.csv");
requireColumns(teamRows, "teams_export.csv", ["team", ...POTS.map((pot) => `pot ${pot}`)]);
if (teamRows.length !== 16) throw new Error(`Expected 16 teams, found ${teamRows.length}`);

// Teams are numbered 1 to 16 in file order
const nameOf = (team: number, pot: number) => teamRows[team - 1][`pot ${pot}`];

// ---------- Pot patterns ----------

// A pattern says which pot plays which: pattern.get(1) = 2 means pot 1 plays pot 2.
// One pot plays its own pot, the other four are split into two swapped pairs.
// 5 choices for the same-pot pot x 3 ways to pair the other four = 15 patterns, one per round
type Pattern = Map<number, number>;
const patterns: Pattern[] = [];
for (const same of POTS) {
	const [a, b, c, d] = POTS.filter((pot) => pot !== same);
	const pairings = [
		[[a, b], [c, d]],
		[[a, c], [b, d]],
		[[a, d], [b, c]],
	];
	for (const [[p1, p2], [p3, p4]] of pairings) {
		patterns.push(new Map([[same, same], [p1, p2], [p2, p1], [p3, p4], [p4, p3]]));
	}
}

// ---------- Rounds ----------

// Circle method: team 16 stays in place, it meets team r in round r.
// The other teams meet in pairs around r: (r + 1, r - 1), (r + 2, r - 2) and so on, wrapping around after 15.
// After 15 rounds every team has met every other team exactly once
type Meeting = [teamA: number, teamB: number];
const wrap = (team: number) => ((team - 1 + 15) % 15) + 1;   // keeps team numbers in 1..15
const rounds: Meeting[][] = [];
for (let r = 1; r <= 15; r++) {
	const meetings: Meeting[] = [[r, 16]];
	for (let i = 1; i <= 7; i++) meetings.push([wrap(r + i), wrap(r - i)]);
	// Lower team number first (that team is player 1), meetings sorted by it
	rounds.push(
		meetings
			.map(([a, b]): Meeting => [Math.min(a, b), Math.max(a, b)])
			.sort((x, y) => x[0] - y[0])
	);
}

// ---------- Games ----------

type Game = { round: number; teamA: number; potA: number; teamB: number; potB: number };
const games: Game[] = [];
rounds.forEach((meetings, i) => {
	const pattern = patterns[i];
	for (const [teamA, teamB] of meetings) {
		for (const potA of POTS) games.push({ round: i + 1, teamA, potA, teamB, potB: pattern.get(potA)! });
	}
});

// ---------- Checks ----------

// Collect every player's opponents, then check: 15 games, every other team once, 3 games against each pot
type Opponent = { team: number; pot: number };
const opponents = new Map<string, Opponent[]>();
const addOpponent = (team: number, pot: number, opponent: Opponent) => {
	const key = `${team}|${pot}`;
	opponents.set(key, [...(opponents.get(key) ?? []), opponent]);
};
for (const game of games) {
	addOpponent(game.teamA, game.potA, { team: game.teamB, pot: game.potB });
	addOpponent(game.teamB, game.potB, { team: game.teamA, pot: game.potA });
}
if (opponents.size !== 16 * POTS.length) throw new Error(`Only ${opponents.size} players have games`);
for (const [key, list] of opponents) {
	const [team, pot] = key.split("|").map(Number);
	const player = nameOf(team, pot);
	const otherTeams = new Set(list.map((opponent) => opponent.team));
	if (list.length !== 15) throw new Error(`${player} has ${list.length} games instead of 15`);
	if (otherTeams.size !== 15 || otherTeams.has(team)) throw new Error(`${player} doesn't meet every other team once`);
	for (const opponentPot of POTS) {
		const count = list.filter((opponent) => opponent.pot === opponentPot).length;
		if (count !== 3) throw new Error(`${player} has ${count} games against pot ${opponentPot} instead of 3`);
	}
}

// ---------- Output ----------

writeCsv("matchups.csv", [
	["player 1", "score 1", "player 2", "score 2"],
	...games.map((game) => [nameOf(game.teamA, game.potA), "", nameOf(game.teamB, game.potB), ""]),
]);

// Overview of the rounds: which rows of matchups.csv, which pot pattern, which team meetings
console.table(
	rounds.map((meetings, i) => ({
		round: i + 1,
		rows: `${i * 40 + 2}-${i * 40 + 41}`,
		pots: [...patterns[i]]
			.filter(([p, q]) => p <= q)
			.sort((x, y) => x[0] - y[0])
			.map(([p, q]) => `${p}-${q}`)
			.join(", "),
		meetings: meetings.map(([a, b]) => `${a}-${b}`).join(" "),
	}))
);
console.log(`${games.length} games written to matchups.csv. All checks passed.`);
