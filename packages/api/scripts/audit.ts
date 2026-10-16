/**
 * Read the audit log (README.md, "Detection"): a timeline of what happened through the API, oldest first, each row with
 * the trace id that finds its request in Cloudflare's dashboard (while Workers Logs still keep it: 3 days on Free).
 *
 *   npm run audit                          the last 7 days, dev
 *   npm run audit -- --suspicious          only refusals, limits, alerts — leaving out sign-ins and the calls that worked
 *   npm run audit -- --grant <id>          one sign-in: everything it did and was refused
 *   npm run audit -- --user <id>           one user, across sign-ins
 *   npm run audit -- --ip <hash>           one IP hash (they match within a day)
 *   npm run audit -- --event proxy_call    one kind of event
 *   npm run audit -- --since 24h --limit 50 --env production
 *
 * It asks D1 through wrangler (logged in as you), so it reads exactly what's stored and nothing more.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const ROUTINE = ["login", "token_issued", "refreshed", "grant_revoked", "github_refresh_refused", "proxy_call"];

const { values } = parseArgs({
	"options": {
		"env": { "type": "string", "default": "dev" },
		"grant": { "type": "string" },
		"user": { "type": "string" },
		"ip": { "type": "string" },
		"event": { "type": "string" },
		"since": { "type": "string", "default": "7d" },
		"limit": { "type": "string", "default": "200" },
		"suspicious": { "type": "boolean", "default": false }
	}
});

/** An id, hash or event name as it's stored: anything else is refused before it's near SQL. */
function plain(name: string, value: string | undefined): string | undefined {
	if (value !== undefined && !/^[\w-]+$/u.test(value)) {
		throw new Error(`--${name} isn't an id: ${value}`);
	}

	return value;
}

const span = /^(\d+)([hd])$/u.exec(values.since);

if (span === null) {
	throw new Error("--since is a number of hours or days: 24h, 7d");
}

const after = Date.now() - Number(span[1]) * (span[2] === "h" ? 3_600_000 : 86_400_000);
const where = [`at >= ${after}`];
const grant = plain("grant", values.grant);
const user = plain("user", values.user);
const ip = plain("ip", values.ip);
const event = plain("event", values.event);

if (grant !== undefined) {
	where.push(`grant_id = '${grant}'`);
}

if (user !== undefined) {
	where.push(`user_id = '${user}'`);
}

if (ip !== undefined) {
	where.push(`ip_hash = '${ip}'`);
}

if (event !== undefined) {
	where.push(`event = '${event}'`);
}

if (values.suspicious) {
	where.push(`event NOT IN (${ROUTINE.map((name) => `'${name}'`).join(", ")})`);
}

const sql = `SELECT at, event, reason, detail, user_id, grant_id, country, ip_hash, trace_id FROM (SELECT * FROM audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${Number(values.limit)}) ORDER BY id`;
const database = values.env === "production" ? "editor-api" : `editor-api-${values.env}`;
const output = execFileSync("npx", ["wrangler", "d1", "execute", database, "--env", values.env, "--remote", "--json", "--command", sql], { "encoding": "utf8", "stdio": ["ignore", "pipe", "inherit"] });
const rows = (JSON.parse(output) as { "results": Record<string, string | number | null>[] }[])[0]?.results ?? [];
const short = (id: unknown): string => (typeof id === "string" ? id.slice(0, 8) : "-");

for (const row of rows) {
	process.stdout.write([
		new Date(row["at"] as number).toISOString().replace("T", " ").slice(0, 19),
		String(row["event"]).padEnd(22),
		`user ${short(row["user_id"])}`,
		`grant ${short(row["grant_id"])}`,
		`${row["country"] ?? "--"} ${row["ip_hash"] ?? ""}`.trim(),
		row["reason"] ?? "",
		row["detail"] ?? "",
		row["trace_id"] === null ? "" : `trace ${row["trace_id"]}`
	].filter((part) => part !== "").join("  ") + "\n");
}

process.stderr.write(`${rows.length} row(s), ${database}, since ${new Date(after).toISOString()}\n`);
