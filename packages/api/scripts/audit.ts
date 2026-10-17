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
 *   npm run audit -- --verify [--env production]   D1 against its locked R2 copies (src/audit-copies.ts): every row
 *                                                    edited, deleted before its time, or never copied
 *
 * It asks D1 through wrangler (logged in as you), so it reads exactly what's stored and nothing more. --verify reads the
 * copies through Cloudflare's API with wrangler's own login (or CLOUDFLARE_API_TOKEN, if set), never printed.
 */
import type { Copy, Row } from "../src/audit-copies.ts";
import { execFileSync } from "node:child_process";
import * as fs from "@brianjenkins94/util/fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { compare, parseKey, ROUTINE } from "../src/audit-copies.ts";

const { values } = parseArgs({
	"options": {
		"env": { "type": "string", "default": "dev" },
		"grant": { "type": "string" },
		"user": { "type": "string" },
		"ip": { "type": "string" },
		"event": { "type": "string" },
		"since": { "type": "string", "default": "7d" },
		"limit": { "type": "string", "default": "200" },
		"suspicious": { "type": "boolean", "default": false },
		"verify": { "type": "boolean", "default": false }
	}
});

const database = values.env === "production" ? "editor-api" : `editor-api-${values.env}`;

/** One SQL statement against the environment's D1, through wrangler: its rows. */
function query<T>(sql: string): T[] {
	const output = execFileSync("npx", ["wrangler", "d1", "execute", database, "--env", values.env, "--remote", "--json", "--command", sql], { "encoding": "utf8", "stdio": ["ignore", "pipe", "inherit"] });

	return (JSON.parse(output) as { "results": T[] }[])[0]?.results ?? [];
}

if (values.verify) {
	await verify();
	process.exit();
}

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
	// Admins reading is kept a year, but it's expected: not worth a second look.
	where.push(`event NOT IN (${[...ROUTINE, "admin_access"].map((name) => `'${name}'`).join(", ")})`);
}

const sql = `SELECT at, event, reason, detail, user_id, grant_id, country, ip_hash, trace_id FROM (SELECT * FROM audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${Number(values.limit)}) ORDER BY id`;
const rows = query<Record<string, string | number | null>>(sql);
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

/** Cloudflare's API as you: CLOUDFLARE_API_TOKEN, or wrangler's own login (refreshed first by `wrangler whoami`). */
function token(): string {
	if (process.env["CLOUDFLARE_API_TOKEN"] !== undefined) {
		return process.env["CLOUDFLARE_API_TOKEN"];
	}

	execFileSync("npx", ["wrangler", "whoami"], { "stdio": "ignore" });

	for (const path of [`${homedir()}/Library/Preferences/.wrangler/config/default.toml`, `${process.env["XDG_CONFIG_HOME"] ?? `${homedir()}/.config`}/.wrangler/config/default.toml`]) {
		try {
			const found = /^oauth_token\s*=\s*"([^"]+)"/mu.exec(fs.readFileSync(path, { "encoding": "utf-8" }))?.[1];

			if (found !== undefined) {
				return found;
			}
		} catch { /* not this platform's path */ }
	}

	throw new Error("no Cloudflare login: run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN");
}

/** D1's rows, the bucket's copies, and what comparing them found. Exits 1 when something's wrong. */
async function verify(): Promise<void> {
	const bearer = { "authorization": `Bearer ${token()}` };
	const cloudflare = async (path: string): Promise<Response> => {
		const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { "headers": bearer });

		if (!response.ok) {
			throw new Error(`${path}: ${response.status}`);
		}

		return response;
	};
	const account = (await (await cloudflare("/accounts")).json() as { "result": { "id": string }[] }).result[0]?.id;
	const bucket = `/accounts/${account}/r2/buckets/${values.env === "production" ? "editor-api-audit" : `editor-api-audit-${values.env}`}`;
	const keys: string[] = [];

	for (let cursor: string | undefined = ""; cursor !== undefined;) {
		const page = await (await cloudflare(`${bucket}/objects?per_page=1000${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`)).json() as { "result": { "key": string }[]; "result_info"?: { "cursor"?: string; "is_truncated"?: boolean } };

		keys.push(...page.result.map((object) => object.key));
		cursor = page.result_info?.is_truncated === true ? page.result_info.cursor : undefined;
	}

	const copies = new Map<number, Copy>();
	const queue = [...keys];

	await Promise.all(Array.from({ "length": 16 }, async () => {
		for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
			const parsed = parseKey(key);

			if (parsed === undefined) {
				continue;
			}

			const body = await (await cloudflare(`${bucket}/objects/${key}`)).json() as Row & { "reason": string | null };
			const entry = copies.get(parsed.id) ?? { "row": undefined as unknown as Row };

			if (parsed.finished) {
				entry.finished = body.reason ?? undefined;
			} else {
				entry.row = body;
			}

			copies.set(parsed.id, entry);
		}
	}));

	const rows: Row[] = [];

	for (let after = 0; ;) {
		const page = query<Row>(`SELECT id, at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id FROM audit WHERE id > ${after} ORDER BY id LIMIT 5000`);

		rows.push(...page);

		if (page.length < 5000) {
			break;
		}

		after = page[page.length - 1]?.id ?? after;
	}

	// A `.finished` part without its row's copy: the copy it finishes is missing.
	const orphans = [...copies].filter(([, entry]) => entry.row === undefined).map(([id]) => id);

	for (const id of orphans) {
		copies.delete(id);
	}

	const verdict = compare(rows, copies);

	verdict.findings.push(...orphans.map((id) => ({ "id": id, "kind": "missing" as const, "detail": "a .finished copy without its row's copy" })));

	for (const finding of verdict.findings) {
		process.stdout.write(`${finding.id}  ${finding.kind.padEnd(10)}  ${finding.detail}\n`);
	}

	process.stderr.write(`${database}: ${rows.length} row(s), ${copies.size} cop${copies.size === 1 ? "y" : "ies"}: ${verdict.matching} matching, ${verdict.anonymized} anonymized (account deleted), ${verdict.expired} expired, ${verdict.before} from before copies began, ${verdict.findings.length} finding(s)\n`);
	process.exitCode = verdict.findings.length === 0 ? 0 : 1;
}
