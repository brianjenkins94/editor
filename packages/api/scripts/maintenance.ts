/**
 * The kill switch, from your own machine (README.md, O1): the break glass for when even the admin app
 * can't be reached. It writes the switch's one D1 row through wrangler (logged in as you), so there's no secret endpoint
 * to protect; then it asks the API's /status, so a Worker notices the flip at once: audits it and emails the owner, as
 * for a flip made from the admin app.
 *
 *   npm run maintenance -- status [--env production]
 *   npm run maintenance -- on --reason "what's wrong" [--env production]
 *   npm run maintenance -- off [--env production]
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	"allowPositionals": true,
	"options": {
		"env": { "type": "string", "default": "dev" },
		"reason": { "type": "string" }
	}
});

const database = values.env === "production" ? "editor-api" : `editor-api-${values.env}`;
const api = values.env === "production" ? "https://api.unusuallygood.dev" : `https://editor-api-${values.env}.brianjenkins94.workers.dev`;
const [command] = positionals;

function d1<T>(sql: string): T[] {
	const output = execFileSync("npx", ["wrangler", "d1", "execute", database, "--env", values.env, "--remote", "--json", "--command", sql], { "encoding": "utf8", "stdio": ["ignore", "pipe", "inherit"] });

	return (JSON.parse(output) as { "results": T[] }[])[0]?.results ?? [];
}

/** A string as an SQL literal: single quotes doubled. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

if (command === "on" || command === "off") {
	const reason = values.reason ?? (command === "on" ? "turned on with npm run maintenance" : null);

	d1(`UPDATE maintenance SET switched_on = ${command === "on" ? 1 : 0}, reason = ${reason === null ? "NULL" : literal(reason)}, by = 'break glass', at = ${Date.now()}, noticed = 0 WHERE id = 1`);
	// A request makes a Worker read the row and notice the flip (audit it, email the owner); /status is always answered.
	await fetch(`${api}/status`).catch(() => undefined);
} else if (command !== "status") {
	console.error("npm run maintenance -- status | on --reason \"…\" | off   [--env dev|production]");
	process.exit(1);
}

const [row] = d1<{ "switched_on": number; "reason": string | null; "by": string | null; "at": number | null; "noticed": number }>("SELECT switched_on, reason, by, at, noticed FROM maintenance WHERE id = 1");

console.log(row === undefined ? "no switch row: has migrations/0014 run?" : `${values.env}: ${row.switched_on === 1 ? "DOWN for maintenance" : "up"}${row.reason === null ? "" : ` (${row.reason})`}, by ${row.by ?? "nobody yet"}${row.at === null ? "" : ` at ${new Date(row.at).toISOString()}`}${row.noticed === 0 ? ", not yet noticed by a Worker" : ""}`);
