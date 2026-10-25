import { readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";

// ---------- Settings ----------

// Satisfaction by number of satisfied connections (index 0 to 4)
const SATISFACTION = [0, 0.5, 0.7, 0.85, 1.0];

// The curve as two aligned lines, for the help text
const SATISFACTION_TEXT = [
	"satisfied connections:  " + SATISFACTION.map((_, count) => String(count).padEnd(6)).join(""),
	"satisfaction:           " + SATISFACTION.map((score) => String(score).padEnd(6)).join(""),
].join("\n  ");

const HELP = `Forms teams of 5 (one player per pot) from ticket exchanges.

Reads data/players.csv (discord_id,pot) and data/tickets.csv (the bot's ticket export).
Only players listed in players.csv take part.
Only mutual tickets count as connections. The script searches for the arrangement
with the highest total satisfaction, fills the remaining slots randomly,
and writes the result to report.html and teams.csv.

Satisfaction per player:
  ${SATISFACTION_TEXT}

Usage:
  node main.ts           single run with seed 1
  node main.ts 7         single run with seed 7
  node main.ts -x        20 runs, shows the best result
  node main.ts -x 50     50 runs, shows the best result
  node main.ts -h        show this help

Seed 1 starts from the pre-sorted order, seeds 2 and up from a random order.
The same seed and the same input files always give the same teams.`;

const args = process.argv.slice(2);

if (args[0] === "-h" || args[0] === "--help") {
	console.log(HELP);
	process.exit(0);
}

const MULTI = args[0] === "-x";
const RUNS = MULTI ? Number(args[1] ?? 20) : 1;
const SINGLE_SEED = MULTI ? undefined : Number(args[0] ?? 1);

if (!Number.isInteger(MULTI ? RUNS : SINGLE_SEED)) {
	console.log(HELP);
	process.exit(1);
}

// Steps without improvement before going back to the best order
const STALL_LIMIT = 100;

// Scores closer than this count as equal (decimal fractions aren't stored exactly)
const EPSILON = 1e-9;

// ---------- Random ----------

// Seeded random generator (mulberry32): same seed gives the same sequence
const makeRandom = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

// Random generator for the player tiebreaker in the pre-sorted order
const setupRandom = makeRandom(1);

// Returns a shuffled copy of a list (Fisher-Yates)
const shuffle = <T>(list: T[], random: () => number) => {
	const copy = [...list];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
};

// ---------- Report ----------

// Escape text so player names can't break the HTML
const escapeHtml = (value: unknown) =>
	String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const report: string[] = [];

// Print a line to the console and add it to the report
const note = (text: string) => {
	console.log(text);
	report.push(`<p>${escapeHtml(text)}</p>`);
};

type ShowOptions = {
	cellClass?: (value: unknown) => string | undefined;   // CSS class for a cell, to color it in the HTML report
	index?: boolean;                                       // show the row number column (default: yes)
};

// Print a table to the console and add it to the report
const show = (title: string, rows: Record<string, unknown>[], { cellClass, index = true }: ShowOptions = {}) => {
	console.log(title);
	// Keys 1, 2, 3... become the index column, so it starts at 1 instead of 0
	console.table(index ? Object.fromEntries(rows.map((row, i) => [i + 1, row])) : rows);
	report.push(`<h2>${escapeHtml(title)}</h2>`);
	if (rows.length === 0) {
		report.push("<p>None</p>");
		return;
	}
	const columns = Object.keys(rows[0]);
	const cell = (value: unknown) => {
		const className = cellClass?.(value);
		return className ? `<td class="${className}">${escapeHtml(value)}</td>` : `<td>${escapeHtml(value)}</td>`;
	};
	const head = (index ? `<th>#</th>` : "") + columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
	const body = rows
		.map((row, i) => `<tr>${index ? `<td>${i + 1}</td>` : ""}${columns.map((c) => cell(row[c])).join("")}</tr>`)
		.join("\n");
	report.push(`<table><tr>${head}</tr>\n${body}</table>`);
};

// Write report.html and open it in the default browser
const openReport = () => {
	const html = `<!doctype html>
<meta charset="utf-8">
<title>Team formation</title>
<style>
	body { font-family: sans-serif; margin: 24px; }
	table { border-collapse: collapse; margin-bottom: 24px; }
	th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: left; }
	th { background: #f0f0f0; }
	.group1 { background: #cfe5ff; }
	.group2 { background: #ffe0b3; }
</style>
<h1>Team formation</h1>
${report.join("\n")}`;
	writeFileSync("report.html", html);

	const opener =
		process.platform === "win32" ? 'start ""' :
		process.platform === "darwin" ? "open" :
		"xdg-open";
	exec(`${opener} report.html`);
};

// ---------- Input ----------

// Reads a CSV file into one object per row, keyed by the header names.
// Handles quoted fields ("a, b" and "" for a quote inside quotes) and the invisible BOM some exports start with
const readCsv = (path: string) => {
	const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	const lines: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') {
				quoted = false;
			} else {
				field += c;
			}
		} else if (c === '"') {
			quoted = true;
		} else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			lines.push(row);
			row = [];
			field = "";
		} else {
			field += c;
		}
	}
	row.push(field);
	lines.push(row);

	const [header, ...data] = lines.filter((line) => line.some((value) => value.trim() !== ""));
	return data.map((values) =>
		Object.fromEntries(header.map((name, i) => [name.trim(), (values[i] ?? "").trim()]))
	);
};

// Stops with a clear message if a CSV file doesn't have the columns the script needs
const requireColumns = (rows: Record<string, string>[], path: string, columns: string[]) => {
	for (const column of columns) {
		if (rows.length > 0 && !(column in rows[0])) throw new Error(`${path} has no column "${column}"`);
	}
};

type Ticket = [ from: string, to: string ];

type Player = {
	id: string;
	pot: number;
	connections: string[];   // ids of mutually connected players
	nonmutuals: string[];    // ids they sent a ticket to without getting one back
	random: number;          // tiebreaker for sorting
};

// players.csv: discord_id,pot. This list decides who takes part
const playerRows = readCsv("data/players.csv");
requireColumns(playerRows, "data/players.csv", ["discord_id", "pot"]);
const playerData = new Map(playerRows.map((r) => [r.discord_id, Number(r.pot)]));
const ids = [...playerData.keys()];

// tickets.csv: the bot's export, one row per ticket slot. Rows without a target are unused tickets
const ticketRows = readCsv("data/tickets.csv");
requireColumns(ticketRows, "data/tickets.csv", ["owner_discord_id", "owner_name", "target_discord_id", "target_name"]);
const tickets: Ticket[] = ticketRows
	.filter((r) => r.target_discord_id !== "")
	.map((r) => [r.owner_discord_id, r.target_discord_id]);

// id -> name from the export, for readable tables. Duplicate names get their id added
const exportNames = new Map<string, string>();
for (const r of ticketRows) {
	if (r.owner_name) exportNames.set(r.owner_discord_id, r.owner_name);
	if (r.target_discord_id && r.target_name) exportNames.set(r.target_discord_id, r.target_name);
}
const nameUses = new Map<string, number>();
for (const id of ids) {
	const name = exportNames.get(id) ?? id;
	nameUses.set(name, (nameUses.get(name) ?? 0) + 1);
}
const nameOf = (id: string) => {
	const name = exportNames.get(id) ?? id;
	return (nameUses.get(name) ?? 0) > 1 ? `${name} (${id})` : name;
};

// Players in the export who are not in players.csv are ignored, list them so nobody is missed by accident
const ignored = [...new Set(ticketRows.map((r) => r.owner_discord_id))].filter((id) => !playerData.has(id));
if (ignored.length > 0) {
	note(`Ignored (in the ticket export but not in players.csv): ${ignored.map((id) => exportNames.get(id) ?? id).join(", ")}`);
}

// id -> ids of players they sent a ticket to
const playerTickets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
for (const [from, to] of tickets) playerTickets.get(from)?.add(to);

const players: Player[] = ids.map((id) => {
	const sentTo = [...playerTickets.get(id)!];
	return {
		id,
		pot: playerData.get(id)!,
		connections: sentTo.filter((other) => playerTickets.get(other)?.has(id)),
		nonmutuals: sentTo.filter((other) => !playerTickets.get(other)?.has(id)),
		random: setupRandom(),
	};
});

// Sort players by number of connections, then by pot, then by random tiebreaker
const connected = players
	.filter((p) => p.connections.length > 0)
	.sort((a, b) =>
		b.connections.length - a.connections.length ||
		a.pot - b.pot ||
		a.random - b.random
	);

// Log players with non-mutual tickets
show(
	"Non-mutual tickets",
	players
		.filter((p) => p.nonmutuals.length > 0)
		.map(({ id, pot, nonmutuals }) => ({
			name: nameOf(id),
			pot,
			nonmutuals: nonmutuals.map(nameOf).join(", "),
		}))
);

// ---------- Connections ----------

type Connection = [ a: string, b: string ];

// Each mutual connection once, in the priority order of `connected`
const initialOrder: Connection[] = [];
const seen = new Set<string>();
for (const p of connected) {
	for (const other of p.connections) {
		const key = [p.id, other].sort().join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		initialOrder.push([p.id, other]);
	}
}

// ---------- Groups ----------

type Group = Map<number, string>;              // pot -> player id
type PlayerGroups = Map<string, Group>;        // player id -> their group

// Two groups can merge if they don't have any players in the same pot
const canMerge = (a: Group, b: Group) => [...a.keys()].every((pot) => !b.has(pot));

// Waterfall: go through connections in order, merge groups where possible
const buildPlayerGroups = (order: Connection[]) => {
	// Every connected player starts in their own group
	const playerGroups: PlayerGroups = new Map();
	for (const p of connected) playerGroups.set(p.id, new Map([[p.pot, p.id]]));

	for (const [x, y] of order) {
		const a = playerGroups.get(x)!;
		const b = playerGroups.get(y)!;
		if (a === b || !canMerge(a, b)) continue;

		// Move everyone from b into a
		for (const [pot, id] of b) {
			a.set(pot, id);
			playerGroups.set(id, a);
		}
	}
	return playerGroups;
};

// Connections whose two players ended up in different groups
const droppedConnections = (order: Connection[], playerGroups: PlayerGroups) =>
	order.filter(([x, y]) => playerGroups.get(x) !== playerGroups.get(y));

// ---------- Scoring ----------

// Number of a player's connections who are in the same group
const satisfiedCount = (p: Player, playerGroups: PlayerGroups) =>
	p.connections.filter((other) => playerGroups.get(other) === playerGroups.get(p.id)).length;

const satisfaction = (p: Player, playerGroups: PlayerGroups) =>
	SATISFACTION[satisfiedCount(p, playerGroups)];

// Global satisfaction: sum over all connected players
const totalScore = (playerGroups: PlayerGroups) =>
	connected.reduce((sum, p) => sum + satisfaction(p, playerGroups), 0);

// ---------- Search ----------

// One search run: start from an order, return the best order found
const search = (startOrder: Connection[], random: () => number) => {
	let order = startOrder;
	let playerGroups = buildPlayerGroups(order);
	const baseScore = totalScore(playerGroups);

	let bestOrder = order;
	let bestScore = baseScore;

	const triedFromBest = new Set<Connection>();   // first moves already tried from the best order
	let atBest = true;                             // is the current order the best order?
	let stall = 0;                                 // iterations since the last improvement
	let iterations = 0;                            // moves tried
	let improvements = 0;                          // times a new best score was found
	let jumpsBack = 0;                             // times we went back to the best order

	while (true) {
		// Stuck for too long: go back to the best order
		if (stall >= STALL_LIMIT) {
			order = bestOrder;
			playerGroups = buildPlayerGroups(order);
			atBest = true;
			stall = 0;
			jumpsBack++;
		}

		// Candidate moves: dropped connections (from the best order, only untried ones)
		let candidates = droppedConnections(order, playerGroups);
		if (atBest) candidates = candidates.filter((c) => !triedFromBest.has(c));

		if (candidates.length === 0) {
			if (atBest) break;     // every first move from the best order has been tried: done
			stall = STALL_LIMIT;   // nothing to move here: go back to the best order
			continue;
		}

		// Move a random candidate to the top and rerun the waterfall
		const pick = candidates[Math.floor(random() * candidates.length)];
		if (atBest) triedFromBest.add(pick);
		atBest = false;

		order = [pick, ...order.filter((c) => c !== pick)];
		playerGroups = buildPlayerGroups(order);
		const score = totalScore(playerGroups);
		iterations++;

		if (score > bestScore + EPSILON) {
			bestOrder = order;
			bestScore = score;
			triedFromBest.clear();
			atBest = true;
			stall = 0;
			improvements++;
		} else {
			stall++;
		}
	}

	return { baseScore, bestScore, bestOrder, iterations, improvements, jumpsBack };
};

// ---------- Runs ----------

type RunResult = ReturnType<typeof search> & { seed: number };

const runs: RunResult[] = [];
let best: RunResult | undefined;

// Either the one chosen seed, or seeds 1 to RUNS
const seeds = SINGLE_SEED !== undefined ? [SINGLE_SEED] : Array.from({ length: RUNS }, (_, i) => i + 1);

for (const seed of seeds) {
	const random = makeRandom(seed);
	const startOrder = seed === 1 ? initialOrder : shuffle(initialOrder, random);
	const result = { seed, ...search(startOrder, random) };
	runs.push(result);

	// Keep the first run that reaches the highest score
	if (!best || result.bestScore > best.bestScore + EPSILON) best = result;
}

show(
	"Runs",
	runs.map((r) => ({
		seed: r.seed,
		start: r.seed === 1 ? "pre-sorted" : "random",
		"base score": r.baseScore.toFixed(2),
		"best score": r.bestScore.toFixed(2),
		iterations: r.iterations,
		improvements: r.improvements,
		"jumps back": r.jumpsBack,
	}))
);

// ---------- Result ----------

const playerGroups = buildPlayerGroups(best!.bestOrder);
const dropped = droppedConnections(best!.bestOrder, playerGroups);

const reachedBest = runs.filter((r) => r.bestScore > best!.bestScore - EPSILON).length;

if (SINGLE_SEED !== undefined) {
	note(`Seed ${best!.seed}: score ${best!.bestScore.toFixed(2)}`);
} else {
	note(`Best score: ${best!.bestScore.toFixed(2)} (seed ${best!.seed}), reached by ${reachedBest} of ${RUNS} runs`);
}
note(`Connections: ${initialOrder.length}, satisfied: ${initialOrder.length - dropped.length}, dropped: ${dropped.length}`);
show(
	"Satisfaction per player",
	SATISFACTION.map((score, count) => ({ "satisfied connections": count, satisfaction: score })),
	{ index: false },
);

// ---------- Teams ----------

const pots = [1, 2, 3, 4, 5];
const teamCount = ids.length / 5;

// Every pot needs exactly one player per team
for (const pot of pots) {
	const count = ids.filter((id) => playerData.get(id) === pot).length;
	if (count !== teamCount) throw new Error(`Pot ${pot} has ${count} players, expected ${teamCount}`);
}

// The best run's seed also decides packing and filling, so one seed reproduces everything
const teamRandom = makeRandom(best!.seed);

// Groups of 2 or more players, largest first (shuffled first, so equal sizes come in random order)
const linkedGroups = shuffle([...new Set(playerGroups.values())], teamRandom)
	.filter((group) => group.size > 1)
	.sort((a, b) => b.size - a.size);

const teams: Group[] = Array.from({ length: teamCount }, () => new Map());

// Place groups into teams without splitting them. Backtracks if a placement leads to a dead end
const pack = (i: number): boolean => {
	if (i === linkedGroups.length) return true;
	const group = linkedGroups[i];
	let triedEmptyTeam = false;
	for (const team of teams) {
		// All empty teams are the same, so trying one of them is enough
		if (team.size === 0) {
			if (triedEmptyTeam) continue;
			triedEmptyTeam = true;
		}
		if (!canMerge(team, group)) continue;

		for (const [pot, id] of group) team.set(pot, id);
		if (pack(i + 1)) return true;
		for (const pot of group.keys()) team.delete(pot);
	}
	return false;
};
if (!pack(0)) throw new Error("The groups can't be packed into teams");

// Fill the remaining slots with random players from the right pot
const placed = new Set(teams.flatMap((team) => [...team.values()]));
for (const pot of pots) {
	const pool = shuffle(ids.filter((id) => playerData.get(id) === pot && !placed.has(id)), teamRandom);
	for (const team of teams) {
		if (!team.has(pot)) team.set(pot, pool.pop()!);
	}
}

// Shuffle the team order, so a team's number doesn't show how it was formed.
// splice replaces the array's contents in place, since teams is a const
teams.splice(0, teams.length, ...shuffle(teams, teamRandom));

// Color per player: group1 / group2 for the first / second ticket group within their team
const playerColor = new Map<string, string>();
for (const team of teams) {
	const teamGroups: Group[] = [];
	for (const id of team.values()) {
		const group = playerGroups.get(id);
		if (!group || group.size < 2) continue;
		if (!teamGroups.includes(group)) teamGroups.push(group);
		playerColor.set(nameOf(id), `group${teamGroups.indexOf(group) + 1}`);
	}
}

// Log teams, one column per pot, plus the team's total satisfaction
const playerById = new Map(players.map((p) => [p.id, p]));
show(
	"Teams",
	teams.map((team) => ({
		...Object.fromEntries(pots.map((pot) => [`pot ${pot}`, nameOf(team.get(pot)!)])),
		satisfaction: [...team.values()]
			.reduce((sum, id) => sum + satisfaction(playerById.get(id)!, playerGroups), 0)
			.toFixed(2),
	})),
	{ cellClass: (value) => playerColor.get(String(value)) },
);
note("Colored: players placed together by tickets (one color per ticket group). White: random fill.");

// Write teams.csv for the tournament spreadsheet: one row per team, one column per pot.
// Values with a comma or quote are wrapped in quotes, so names can't break the columns
const csvValue = (value: unknown) => {
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvRows = [
	["team", ...pots.map((pot) => `pot ${pot}`)],
	...teams.map((team, i) => [i + 1, ...pots.map((pot) => team.get(pot))]),
];
writeFileSync("teams.csv", csvRows.map((row) => row.map(csvValue).join(",")).join("\n") + "\n");

// The same teams with player names instead of ids, for importing into Google Sheets
const csvNameRows = [
	["team", ...pots.map((pot) => `pot ${pot}`)],
	...teams.map((team, i) => [i + 1, ...pots.map((pot) => nameOf(team.get(pot)!))]),
];
writeFileSync("teams_export.csv", csvNameRows.map((row) => row.map(csvValue).join(",")).join("\n") + "\n");
note("Teams written to teams.csv (Discord ids) and teams_export.csv (names)");

// Log satisfaction per player, including dropped connections
show(
	"Satisfaction",
	connected.map((p) => ({
		name: nameOf(p.id),
		pot: p.pot,
		satisfied: `${satisfiedCount(p, playerGroups)}/${p.connections.length}`,
		score: satisfaction(p, playerGroups),
		dropped: p.connections
			.filter((other) => playerGroups.get(other) !== playerGroups.get(p.id))
			.map(nameOf)
			.join(", "),
	}))
);

openReport();
