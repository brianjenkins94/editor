import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";

/**
 * Our own inbox (README.md, the Email runbook): Email Routing sends mail for a few addresses of ours (INBOX,
 * in wrangler.jsonc: the smoke test's) to this Worker's `email` handler, and it keeps who sent each, its subject and size;
 * never its body. Anything to another address is rejected. Kept a day: long enough for the smoke test (src/smoke.ts) to
 * read its code, and for a look on the Mail page.
 */

/** The largest message kept: a sign-in code's email is a few kilobytes. */
const LARGEST = 256 * 1024;

const KEPT = 86_400_000;

/** Our addresses, from INBOX (comma-separated), lowercased. */
export const inboxAddresses = (env: Bindings): string[] => (env.INBOX ?? "").split(",").map((address) => address.trim().toLowerCase()).filter((address) => address !== "");

/** Keep it: the row the Mail page and the smoke test read. */
export async function deliver(env: Bindings, mail: { "address": string; "sender": string; "subject": string; "size": number }): Promise<void> {
	await env.DB.prepare("INSERT INTO inbox (at, address, sender, subject, size) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), mail.address.toLowerCase(), mail.sender, mail.subject.slice(0, 300), mail.size).run();
}

/** The Worker's `email` handler: Email Routing's delivery to one of our addresses. */
export async function receive(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
	if (!inboxAddresses(env).includes(message.to.toLowerCase())) {
		message.setReject("no such address");

		return;
	}

	if (message.rawSize > LARGEST) {
		message.setReject("message too large");

		return;
	}

	await deliver(env, { "address": message.to, "sender": message.from, "subject": message.headers.get("subject") ?? "", "size": message.rawSize });
}

/** The daily cron: what's older than a day goes. */
export async function expireInbox(db: D1Database, now = Date.now()): Promise<number> {
	return (await db.prepare("DELETE FROM inbox WHERE at < ?").bind(now - KEPT).run()).meta.changes;
}

/** GET /admin/inbox: the latest mail to our addresses: when, to which, from whom, its subject and size. */
export async function inboxEndpoint(context: Context<AppEnv>): Promise<Response> {
	const { results } = await context.env.DB.prepare("SELECT id, at, address, sender, subject, size FROM inbox ORDER BY id DESC LIMIT 50").all();

	return context.json({ "addresses": inboxAddresses(context.env), "mail": results });
}
