import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { base64url } from "jose";
import { copyKey, ROUTINE, ROUTINE_DAYS, SUSPICIOUS_DAYS } from "./audit-copies.ts";

/**
 * The audit log (D1 `audit`; migrations/0001 and 0002): the security record. Never sampled, and kept apart from logs and
 * traces, though every row carries its request's trace id so it joins to them. It holds:
 * - what happened to whose sign-in: login, tokens issued, refreshed, revoked;
 * - every request refused, and why. The one exception is the routine nonce challenge, which every client meets every
 *   few minutes;
 * - every call made through the proxy, reads as much as writes: what it was, GitHub's answer, and how many bytes it
 *   carried back — if something gets through, what it read is what matters;
 * - where a request came from: Cloudflare's country, and an IP hash that only matches within a day.
 *
 * Each row is copied, once, to a locked R2 bucket (audit-copies.ts), so the record can be checked: what the Worker wrote
 * can't later be edited or deleted unnoticed.
 *
 * The events that look like someone doing something they shouldn't through us also raise an alert at once (`alert`).
 */

export type AuditEvent =
	| "login" | "token_issued" | "refreshed" | "grant_revoked" | "github_refresh_refused"
	| "token_rejected" | "refresh_reuse_detected" | "auth_refused" | "sign_in_refused"
	| "rate_limited" | "oversized"
	| "proxy_call" | "proxy_denied" | "proxy_abuse"
	| "account_deleted" | "account_restored" | "account_purged"
	| "admin_access";

/** The retention (audit-copies.ts: ROUTINE_DAYS for the everyday record, SUSPICIOUS_DAYS for the rest), applied daily by
 *  the Worker's cron trigger. Says how many rows went. The copies expire on their own (the bucket's lifecycle rules). */
export async function expire(db: D1Database, now = Date.now()): Promise<number> {
	const day = 86_400_000;
	const [routine, rest] = await db.batch([
		db.prepare(`DELETE FROM audit WHERE at < ? AND event IN (${ROUTINE.map(() => "?").join(", ")})`).bind(now - ROUTINE_DAYS * day, ...ROUTINE),
		db.prepare("DELETE FROM audit WHERE at < ?").bind(now - SUSPICIOUS_DAYS * day)
	]);

	return (routine?.meta.changes ?? 0) + (rest?.meta.changes ?? 0);
}

/** Where a request came from, as much as the audit log keeps, and the trace it's part of. */
export interface Origin {
	"country": string | null;
	"ipHash": string | null;
	"traceId": string | null;
}

/** For what no request started (an alarm, a refresh GitHub refused): no country, no IP, no trace. */
export const NOWHERE: Origin = { "country": null, "ipHash": null, "traceId": null };

/** A request's origin: Cloudflare's country, the client IP as an HMAC under AUDIT_KEY and today's date, and its trace. */
export async function origin(context: Context<AppEnv>): Promise<Origin> {
	const request = context.req.raw;
	const ip = request.headers.get("cf-connecting-ip");
	const country = (request as Request & { "cf"?: { "country"?: string } }).cf?.country ?? null;
	const traceId = (context.get("span") as { "traceId"?: string } | undefined)?.traceId ?? null;

	if (ip === null) {
		return { "country": country, "ipHash": null, "traceId": traceId };
	}

	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${context.env.AUDIT_KEY}:${new Date().toISOString().slice(0, 10)}`), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));

	return { "country": country, "ipHash": base64url.encode(new Uint8Array(mac)).slice(0, 22), "traceId": traceId };
}

/** Who a row is about. */
export interface Subject { "userId"?: string | null; "grantId"?: string | null }

/** Why (a fixed reason string) and what (a proxied call, method and path). */
export interface Particulars { "reason"?: string; "detail"?: string }

/** Events that are someone doing what the editor never does, whatever their reason. */
const ALARMING = new Set<AuditEvent>(["refresh_reuse_detected", "proxy_denied", "proxy_abuse", "rate_limited"]);

/** Reasons that mean a token is in hands it shouldn't be: presented with another key's proof, or a proof replayed. */
const THEFT = new Set(["key is not the one bound", "jti was seen before", "another key"]);

/** Record an event (and alert, if it's one that does). The row's id, for what's only known later (a proxied call's bytes). */
export async function audit(env: Bindings, event: AuditEvent, subject: Subject, from: Origin, particulars: Particulars = {}): Promise<number> {
	const row = { "at": Date.now(), "event": event, "user_id": subject.userId ?? null, "grant_id": subject.grantId ?? null, "country": from.country ?? null, "ip_hash": from.ipHash ?? null, "reason": particulars.reason ?? null, "detail": particulars.detail ?? null, "trace_id": from.traceId ?? null };
	const { meta } = await env.DB.prepare("INSERT INTO audit (at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(row.at, row.event, row.user_id, row.grant_id, row.country, row.ip_hash, row.reason, row.detail, row.trace_id)
		.run();

	await copy(env, copyKey(event, meta.last_row_id), { "id": meta.last_row_id, ...row });

	if (ALARMING.has(event) || THEFT.has(particulars.reason ?? "")) {
		await alert(env, event, subject, from, particulars);
	}

	return meta.last_row_id;
}

/** A proxied call finished: its reason with the bytes it carried, in D1 and as its copy's second, `.finished` part. */
export async function finish(env: Bindings, id: number, reason: string): Promise<void> {
	await env.DB.prepare("UPDATE audit SET reason = ? WHERE id = ?").bind(reason, id).run();
	await copy(env, copyKey("proxy_call", id, ".finished"), { "reason": reason });
}

/**
 * Write a copy once: `if-none-match: *` refuses a key that exists, so not even the Worker can replace one (the bucket
 * lock refuses it too, once applied). Tried twice; a copy that can't be written never fails the request, but is logged,
 * and shows as "not copied" when the log is verified.
 */
async function copy(env: Bindings, key: string, body: object): Promise<void> {
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			await env.AUDIT_COPIES.put(key, JSON.stringify(body), { "onlyIf": new Headers({ "if-none-match": "*" }), "httpMetadata": { "contentType": "application/json" } });

			return;
		} catch (error) {
			if (attempt === 2) {
				// Imported here, not above: log.ts is Worker-only (cloudflare:workers), and Node tests import this module.
				const { log } = await import("./log.ts");

				log.error("audit copy not written", { "error": error instanceof Error ? error.message : String(error) });
			}
		}
	}
}

/**
 * Tell someone now: a POST to ALERT_WEBHOOK (a secret; no alert without one) — at most one a minute for the same event
 * and subject (the ALERTS rate limiter), so a flood is one alert, not thousands. What it says is what the audit row
 * says: ids, a reason, a country, an IP hash, a trace id — never a token or an address. Best effort: an alert that
 * can't be sent never fails the request; the row is the record.
 */
async function alert(env: Bindings, event: AuditEvent, subject: Subject, from: Origin, particulars: Particulars): Promise<void> {
	if (env.ALERT_WEBHOOK === undefined || !(await env.ALERTS.limit({ "key": `${event}:${subject.grantId ?? subject.userId ?? from.ipHash ?? "-"}` })).success) {
		return;
	}

	const text = [
		`[editor-api ${env.ENVIRONMENT}] ${event}${particulars.reason === undefined ? "" : `: ${particulars.reason}`}`,
		particulars.detail,
		[subject.userId === undefined || subject.userId === null ? undefined : `user ${subject.userId}`, subject.grantId === undefined || subject.grantId === null ? undefined : `grant ${subject.grantId.slice(0, 12)}…`, from.country ?? undefined, from.ipHash === null ? undefined : `ip#${from.ipHash}`].filter(Boolean).join(" · "),
		from.traceId === null ? undefined : `trace ${from.traceId}`
	].filter(Boolean).join("\n");

	try {
		const host = new URL(env.ALERT_WEBHOOK).hostname;
		// Discord and Slack take JSON; ntfy (and most else) take the text as it is.
		const body = host.endsWith("discord.com") ? { "headers": { "content-type": "application/json" }, "body": JSON.stringify({ "content": text }) }
			: host === "hooks.slack.com" ? { "headers": { "content-type": "application/json" }, "body": JSON.stringify({ "text": text }) }
				: { "headers": { "content-type": "text/plain", "title": `editor-api: ${event}`, "priority": "high" }, "body": text };

		await fetch(env.ALERT_WEBHOOK, { "method": "POST", ...body, "signal": AbortSignal.timeout(3000) });
	} catch {
		/* the row is the record */
	}
}
