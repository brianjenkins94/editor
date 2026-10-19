import type { Context } from "hono";
import type { AppEnv } from "./env.ts";

/**
 * A sign-in's timeline (OPERATIONS.md, "Session timelines"; O5), for drilling into one person's session from the admin
 * app: every request made through it (held by its Grant: route, status, duration, trace id), what the editor said
 * happened (src/session-events.ts), its audit rows and its errors, in order. Only what signed-in people did; never a screen, code, keystrokes or file contents. Reading it is
 * itself audited (`admin_access`), as every admin read is. `sessions:replay`.
 */

export type Item =
	| { "kind": "request"; "at": number; "route": string; "status": number; "ms": number; "trace": string | null }
	| { "kind": "editor"; "at": number; "name": string; "detail": string | null }
	| { "kind": "audit"; "at": number; "event": string; "reason": string | null; "detail": string | null; "trace": string | null }
	| { "kind": "error"; "at": number; "id": string; "name": string; "route": string | null; "message": string | null; "trace": string | null };

/** GET /admin/sessions/:id/timeline: the sign-in, and its timeline, oldest first. */
export async function timelineEndpoint(context: Context<AppEnv>): Promise<Response> {
	const id = context.req.param("id") ?? "";

	if (!/^[0-9a-f]{64}$/u.test(id)) {
		return context.json({ "error": "not_found" }, 404);
	}

	const [session, audits, errors] = await context.env.DB.batch([
		context.env.DB.prepare("SELECT id, user_id, client, label, method, created_at, last_used_at, revoked_at FROM grants WHERE id = ?").bind(id),
		context.env.DB.prepare("SELECT at, event, reason, detail, trace_id FROM audit WHERE grant_id = ? ORDER BY id LIMIT 1000").bind(id),
		context.env.DB.prepare("SELECT o.at, o.id, e.name, o.route, o.message, o.trace_id FROM error_occurrences o JOIN errors e ON e.fingerprint = o.fingerprint WHERE o.grant_id = ? ORDER BY o.at LIMIT 500").bind(id)
	]);
	const row = session?.results[0];

	if (row === undefined) {
		return context.json({ "error": "not_found" }, 404);
	}

	const grant = context.env.GRANTS.get(context.env.GRANTS.idFromString(id));
	const [requests, editor] = await Promise.all([grant.timeline(), grant.editorTimeline()]);
	const items: Item[] = [
		...requests.map((request): Item => ({ "kind": "request", ...request })),
		...editor.map((event): Item => ({ "kind": "editor", ...event })),
		...(audits?.results ?? []).map((audit): Item => {
			const one = audit as { "at": number; "event": string; "reason": string | null; "detail": string | null; "trace_id": string | null };

			return { "kind": "audit", "at": one.at, "event": one.event, "reason": one.reason, "detail": one.detail, "trace": one.trace_id };
		}),
		...(errors?.results ?? []).map((error): Item => {
			const one = error as { "at": number; "id": string; "name": string; "route": string | null; "message": string | null; "trace_id": string | null };

			return { "kind": "error", "at": one.at, "id": one.id, "name": one.name, "route": one.route, "message": one.message, "trace": one.trace_id };
		})
	].toSorted((a, b) => a.at - b.at);

	return context.json({ "session": row, "items": items });
}
