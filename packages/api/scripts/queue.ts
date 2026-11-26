/**
 * The queue (README.md, *The queue*), from here: what's open, and an item closed with what was done about it — what an
 * agent asked to address the queue works through, as the admin app's Queue page does.
 *
 *   npm run queue                                         what's open, oldest first (production)
 *   npm run queue -- --closed                             the latest closed, with their outcomes
 *   npm run queue -- --close 12 --outcome "Fixed in 1a2b3c4d: …"
 *   npm run queue -- --env dev
 *
 * It asks D1 through wrangler (logged in as you), as scripts/audit.ts does; an item it closes says it was closed here.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	"options": {
		"env": { "type": "string", "default": "production" },
		"closed": { "type": "boolean", "default": false },
		"close": { "type": "string" },
		"outcome": { "type": "string" }
	}
});

const database = values.env === "production" ? "editor-api" : `editor-api-${values.env}`;

/** One SQL statement against the environment's D1, through wrangler: its rows. */
function query<T>(sql: string): T[] {
	const output = execFileSync("npx", ["wrangler", "d1", "execute", database, "--env", values.env, "--remote", "--json", "--command", sql], { "encoding": "utf8", "stdio": ["ignore", "pipe", "inherit"] });

	return (JSON.parse(output) as { "results": T[] }[])[0]?.results ?? [];
}

const text = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const day = (at: number | null): string => (at === null ? "" : new Date(at).toISOString().slice(0, 16).replace("T", " "));

interface Row { "id": number; "at": number; "kind": string; "ref": string | null; "title": string; "detail": string | null; "closed_at": number | null; "outcome": string | null }

if (values.close !== undefined) {
	const id = Number(values.close);
	const outcome = values.outcome?.trim() ?? "";

	if (!Number.isInteger(id) || outcome === "") {
		throw new Error("--close takes an item's id, and --outcome what was done about it");
	}

	const closed = query<{ "id": number }>(`UPDATE queue SET closed_at = ${String(Date.now())}, closed_by = 'agent (scripts/queue.ts)', outcome = ${text(outcome.slice(0, 2000))} WHERE id = ${String(id)} AND closed_at IS NULL RETURNING id`);

	process.stdout.write(closed.length === 0 ? `No open item ${String(id)}.\n` : `Closed ${String(id)}.\n`);
	process.exit(closed.length === 0 ? 1 : 0);
}

const rows = query<Row>(values.closed ? "SELECT * FROM queue WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 50" : "SELECT * FROM queue WHERE closed_at IS NULL ORDER BY at");

if (rows.length === 0) {
	process.stdout.write(values.closed ? "None closed yet.\n" : "Nothing open.\n");
}

for (const row of rows) {
	process.stdout.write(`#${String(row.id)}  ${day(row.at)}  ${row.kind}${row.ref === null ? "" : ` ${row.ref}`}\n  ${row.title}\n${row.detail === null ? "" : `${row.detail.split("\n").map((line) => `  ${line}`).join("\n")}\n`}${row.closed_at === null ? "" : `  closed ${day(row.closed_at)}: ${row.outcome ?? ""}\n`}\n`);
}
