import { base64url } from "jose";

/**
 * The audit log (D1 `audit`, migrations/0001_accounts.sql): what happened to whose sign-in, from which country, and an IP
 * hash that only matches within a day. Never sampled, and kept apart from logs and traces: it's the security record.
 */

export type AuditEvent = "login" | "token_issued" | "refreshed" | "token_rejected" | "refresh_reuse_detected" | "grant_revoked";

/** Where a request came from, as much as the audit log keeps. */
export interface Origin {
	"country": string | null;
	"ipHash": string | null;
}

/** A request's origin: Cloudflare's country, and the client IP as an HMAC under AUDIT_KEY and today's date. */
export async function origin(request: Request, auditKey: string): Promise<Origin> {
	const ip = request.headers.get("cf-connecting-ip");
	const country = (request as Request & { "cf"?: { "country"?: string } }).cf?.country ?? null;

	if (ip === null) {
		return { "country": country, "ipHash": null };
	}

	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${auditKey}:${new Date().toISOString().slice(0, 10)}`), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));

	return { "country": country, "ipHash": base64url.encode(new Uint8Array(mac)).slice(0, 22) };
}

export async function audit(db: D1Database, event: AuditEvent, { userId, grantId }: { "userId"?: string | null; "grantId"?: string | null }, from: Origin): Promise<void> {
	await db.prepare("INSERT INTO audit (at, event, user_id, grant_id, country, ip_hash) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(Date.now(), event, userId ?? null, grantId ?? null, from.country, from.ipHash)
		.run();
}
