import { readFileSync, writeFileSync } from "node:fs";

// Reads a CSV file into one object per row, keyed by the header names.
// Handles quoted fields ("a, b" and "" for a quote inside quotes) and the invisible BOM some exports start with
export const readCsv = (path: string) => {
	const text = readFileSync(path, "utf8").replace(/^﻿/, "");
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
export const requireColumns = (rows: Record<string, string>[], path: string, columns: string[]) => {
	for (const column of columns) {
		if (rows.length > 0 && !(column in rows[0])) throw new Error(`${path} has no column "${column}"`);
	}
};

// Values with a comma or quote are wrapped in quotes, so names can't break the columns
const csvValue = (value: unknown) => {
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Writes rows (the first row is the header) to a CSV file
export const writeCsv = (path: string, rows: unknown[][]) => {
	writeFileSync(path, rows.map((row) => row.map(csvValue).join(",")).join("\n") + "\n");
};
