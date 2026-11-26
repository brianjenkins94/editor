/**
 * The queue (README.md, *The queue*): what was found that someone should look into, kept until it's closed with what
 * was done about it, so nothing found goes unnoticed. A new error group adds one, and so does a group happening again
 * after its item was closed (src/errors.ts); the daily cron adds
 * the week's review of agents' tool use (debug-mcp's agent_usage), once a week. The admin app's Queue page shows them and
 * closes one with its outcome (queue:read, queue:close); asked to address the queue, an agent does the same through
 * scripts/queue.ts.
 */
import type { Context } from "hono";
import type { AppEnv } from "./env.ts";

export type QueueKind = "error" | "agent-use";

export interface QueueItem { "id": number; "at": number; "kind": QueueKind; "ref": string | null; "title": string; "detail": string | null; "closedAt": number | null; "closedBy": string | null; "outcome": string | null }

const WEEK = 7 * 86_400_000;
const KEPT_CLOSED = 365 * 86_400_000;

/** Add an item, unless one of its kind for `ref` is open already. */
export async function addItem(db: D1Database, item: { "kind": QueueKind; "ref"?: string; "title": string; "detail"?: string }, now = Date.now()): Promise<void> {
	await db.prepare("INSERT INTO queue (at, kind, ref, title, detail) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM queue WHERE kind = ? AND ref IS ? AND closed_at IS NULL)")
		.bind(now, item.kind, item.ref ?? null, item.title.slice(0, 200), item.detail?.slice(0, 2000) ?? null, item.kind, item.ref ?? null).run();
}

/** An error group happening again after its item was closed: queued again, once, until that's closed too. */
export async function errorAgain(db: D1Database, item: { "ref": string; "title": string; "detail": string }, now = Date.now()): Promise<void> {
	await db.prepare("INSERT INTO queue (at, kind, ref, title, detail) SELECT ?, 'error', ?, ?, ? WHERE EXISTS (SELECT 1 FROM queue WHERE kind = 'error' AND ref = ? AND closed_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM queue WHERE kind = 'error' AND ref = ? AND closed_at IS NULL)")
		.bind(now, item.ref, item.title.slice(0, 200), item.detail.slice(0, 2000), item.ref, item.ref).run();
}

/** The daily cron: the week's review of agents' tool use, when none is open and the last came a week ago or more; and
 *  closed items a year on. */
export async function dailyQueue(db: D1Database, now = Date.now()): Promise<void> {
	const last = await db.prepare("SELECT MAX(at) AS at FROM queue WHERE kind = 'agent-use'").first<{ "at": number | null }>();

	if (last?.at === null || last?.at === undefined || now - last.at >= WEEK) {
		await addItem(db, {
			"kind": "agent-use",
			"ref": new Date(now).toISOString().slice(0, 10),
			"title": "Review agents' tool use",
			"detail": "debug-mcp's agent_usage (the editor's Features and Tests shows the same): each tool's calls, failures, time and sizes, and its findings — bypasses (an editor tool does it), candidates (a tool to write, its UI first), workarounds, friction and oversize answers. Act on each, or say why not, then close this with what was done."
		}, now);
	}

	await db.prepare("DELETE FROM queue WHERE closed_at IS NOT NULL AND closed_at < ?").bind(now - KEPT_CLOSED).run();
}

const itemOf = (row: Record<string, unknown>): QueueItem => ({ "id": row["id"] as number, "at": row["at"] as number, "kind": row["kind"] as QueueKind, "ref": row["ref"] as string | null, "title": row["title"] as string, "detail": row["detail"] as string | null, "closedAt": row["closed_at"] as number | null, "closedBy": row["closed_by"] as string | null, "outcome": row["outcome"] as string | null });

/** GET /admin/queue: the open items, oldest first; `?closed=1`, the latest closed instead. */
export async function queueEndpoint(context: Context<AppEnv>): Promise<Response> {
	const closed = context.req.query("closed") === "1";
	const { results } = await context.env.DB.prepare(closed ? "SELECT * FROM queue WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 200" : "SELECT * FROM queue WHERE closed_at IS NULL ORDER BY at LIMIT 500").all<Record<string, unknown>>();

	return context.json({ "items": results.map(itemOf) });
}

/** POST /admin/queue/:id/close, `outcome` (what was done about it, said): closed, by whoever closed it. */
export async function closeItemEndpoint(context: Context<AppEnv>): Promise<Response> {
	const outcome = String((await context.req.parseBody())["outcome"] ?? "").trim();
	const id = Number(context.req.param("id"));

	if (outcome === "") {
		return context.json({ "error": "outcome", "reason": "say what was done about it" }, 400);
	}

	const closed = await context.env.DB.prepare("UPDATE queue SET closed_at = ?, closed_by = ?, outcome = ? WHERE id = ? AND closed_at IS NULL RETURNING id").bind(Date.now(), context.get("user"), outcome.slice(0, 2000), Number.isInteger(id) ? id : -1).first();

	return closed === null ? context.json({ "error": "not_found" }, 404) : context.json({ "closed": id });
}
