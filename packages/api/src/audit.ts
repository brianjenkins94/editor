import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { base64url } from "jose";

/**
 * The audit log (D1 `audit`; migrations/0001 and 0002): the security record. Never sampled, and kept apart from logs and
 * traces, though every row carries its request's trace id so it joins to them. It holds:
 * - what happened to whose sign-in: login, tokens issued, refreshed, revoked;
 * - every request refused, and why. The one exception is the routine nonce challenge, which every client meets every
 *   few minutes;
 * - every write made through the proxy;
 * - where a request came from: Cloudflare's country, and an IP hash that only matches within a day.
 *
 * The events that look like someone doing something they shouldn't through us also raise an alert at once (`alert`).
 */

export type AuditEvent =
	| "login" | "token_issued" | "refreshed" | "grant_revoked" | "github_refresh_refused"
	| "token_rejected" | "refresh_reuse_detected" | "auth_refused" | "sign_in_refused"
	| "rate_limited" | "oversized"
	| "proxy_write" | "proxy_denied" | "proxy_abuse";

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

export async function audit(env: Bindings, event: AuditEvent, subject: Subject, from: Origin, particulars: Particulars = {}): Promise<void> {
	await env.DB.prepare("INSERT INTO audit (at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(Date.now(), event, subject.userId ?? null, subject.grantId ?? null, from.country ?? null, from.ipHash ?? null, particulars.reason ?? null, particulars.detail ?? null, from.traceId ?? null)
		.run();

	if (ALARMING.has(event) || THEFT.has(particulars.reason ?? "")) {
		await alert(env, event, subject, from, particulars);
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
