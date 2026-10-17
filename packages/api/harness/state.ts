/**
 * What the API has stored, read from outside it (SIGN-IN.md, C0): every D1 table, every Durable Object's SQLite storage,
 * and the R2 audit copies, through Wrangler's test harness. Nothing here is a route of the Worker, so none of it can be
 * deployed. `npm run harness` shows it live; tests use `recorded` to assert exactly what an action wrote.
 *
 * Secrets are redacted as they're read: sealed values (GitHub's tokens) show as "sealed", hashes by their first
 * characters. What's left is what a developer needs to see a flow happen.
 */
import type { createTestHarness } from "wrangler";

type Harness = ReturnType<typeof createTestHarness>;

type Row = Record<string, unknown>;

/** Everything stored, by collection: `d1:<table>`, `<binding>:<object id>:<table>`, `r2:<binding>`; rows by their key. */
export type Snapshot = Record<string, Record<string, Row>>;

/** The Durable Object namespaces to read, and the R2 buckets. */
const OBJECTS = ["GRANTS"];

const BUCKETS = ["AUDIT_COPIES"];

/** Tables that are the platform's bookkeeping, not ours. */
const INTERNAL = /^(?:sqlite_|_cf_|d1_migrations$)/u;

/** Redact a value by its column: sealed values hidden, hashes and secrets cut to a recognizable prefix. */
function redact(column: string, value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}

	if (column === "github" || column.endsWith("_sealed")) {
		return "sealed";
	}

	return /hash|secret|jti/u.test(column) ? `${value.slice(0, 8)}…` : value;
}

/** A row's key in its collection: its `id`, else the whole row (tables with no id are sets). */
const keyOf = (row: Row): string => ("id" in row ? String(row["id"]) : JSON.stringify(row));

function collect(rows: Row[]): Record<string, Row> {
	return Object.fromEntries(rows.map((row) => {
		const redacted = Object.fromEntries(Object.entries(row).map(([column, value]) => [column, redact(column, value)]));

		return [keyOf(row), redacted];
	}));
}

/** Everything the API's Worker has stored, now. */
export async function snapshot(harness: Harness): Promise<Snapshot> {
	const worker = harness.getWorker();
	const env = await worker.getEnv() as Record<string, unknown>;
	const db = env["DB"] as D1Database;
	const state: Snapshot = {};
	const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ "name": string }>()).results.map((row) => row.name).filter((name) => !INTERNAL.test(name));

	for (const table of tables) {
		state[`d1:${table}`] = collect((await db.prepare(`SELECT * FROM "${table}"`).all<Row>()).results);
	}

	for (const binding of OBJECTS) {
		for (const id of await worker.listDurableObjectIds(binding)) {
			const storage = await worker.getDurableObjectStorage(binding, { "id": id });
			const names = (await storage.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as { "name": string }[]).map((row) => row.name).filter((name) => !INTERNAL.test(name));

			for (const table of names) {
				const rows = await storage.exec(`SELECT * FROM "${table}"`) as Row[];

				if (rows.length > 0) {
					state[`${binding}:${id.slice(0, 12)}:${table}`] = collect(rows);
				}
			}
		}
	}

	for (const binding of BUCKETS) {
		const bucket = env[binding] as R2Bucket;
		const objects: Row[] = [];

		for (let cursor: string | undefined; ;) {
			const page = await bucket.list({ "limit": 1000, ...cursor === undefined ? {} : { "cursor": cursor } });

			objects.push(...page.objects.map((object) => ({ "id": object.key, "size": object.size, "uploaded": object.uploaded.toISOString() })));

			if (!page.truncated) {
				break;
			}

			cursor = page.cursor;
		}

		state[`r2:${binding}`] = collect(objects);
	}

	return state;
}

/** What changed between two snapshots, by collection: rows added, rows removed, and rows changed (before and after). */
export type Changes = Record<string, { "added": Row[]; "removed": Row[]; "changed": { "before": Row; "after": Row }[] }>;

export function diff(before: Snapshot, after: Snapshot): Changes {
	const changes: Changes = {};

	for (const collection of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const was = before[collection] ?? {};
		const now = after[collection] ?? {};
		const entry = {
			"added": Object.keys(now).filter((key) => !(key in was)).map((key) => now[key] as Row),
			"removed": Object.keys(was).filter((key) => !(key in now)).map((key) => was[key] as Row),
			"changed": Object.keys(now).filter((key) => key in was && JSON.stringify(was[key]) !== JSON.stringify(now[key])).map((key) => ({ "before": was[key] as Row, "after": now[key] as Row }))
		};

		if (entry.added.length + entry.removed.length + entry.changed.length > 0) {
			changes[collection] = entry;
		}
	}

	return changes;
}

/** Exactly what `action` wrote: a snapshot before, one after, and the difference. */
export async function recorded(harness: Harness, action: () => Promise<unknown>): Promise<Changes> {
	const before = await snapshot(harness);

	await action();

	return diff(before, await snapshot(harness));
}
