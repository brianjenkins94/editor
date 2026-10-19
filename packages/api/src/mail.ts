import type { Bindings } from "./env.ts";
import { escapeHtml } from "@brianjenkins94/util/text";
import { deliver, inboxAddresses } from "./inbox.ts";
import ALERT_HTML from "./owner-alert.html";
import ALERT_TEXT from "./owner-alert.txt";

/**
 * Sending email (SIGN-IN.md, C2): through Cloudflare Email Service's `send_email` binding (`EMAIL`), from our own
 * address on the zone (its SPF, DKIM and DMARC records are Email Service's to keep). In the harness and the tests,
 * through an outbox stand-in instead (`EMAIL_OUTBOX`, a URL the message is POSTed to as JSON), so nothing leaves the
 * machine and a test can read what was sent; and mail to one of our own addresses (INBOX) goes to our inbox too, as
 * Email Routing would deliver it, so the smoke test (src/smoke.ts) runs there as well.
 */

/** Who our email is from. */
export const FROM = { "email": "no-reply@unusuallygood.dev", "name": "unusually good" };

export interface Mail { "to": string; "subject": string; "text": string; "html": string }

/** Whether this environment can send at all. */
export const canSend = (env: Bindings): boolean => env.EMAIL_OUTBOX !== undefined || env.EMAIL !== undefined;

/** Send it. What went wrong, if it didn't: Email Service's error code (`E_RECIPIENT_SUPPRESSED`, …) or the outbox's
 *  status; never the message. */
export async function send(env: Bindings, mail: Mail): Promise<{ "ok": true } | { "ok": false; "reason": string }> {
	try {
		if (env.EMAIL_OUTBOX !== undefined) {
			const response = await fetch(env.EMAIL_OUTBOX, { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify({ "from": FROM, ...mail }) });

			if (response.ok && inboxAddresses(env).includes(mail.to.toLowerCase())) {
				await deliver(env, { "address": mail.to, "sender": FROM.email, "subject": mail.subject, "size": mail.text.length + mail.html.length });
			}

			return response.ok ? { "ok": true } : { "ok": false, "reason": `outbox ${response.status}` };
		}

		if (env.EMAIL === undefined) {
			return { "ok": false, "reason": "no email binding" };
		}

		await env.EMAIL.send({ "from": FROM, ...mail });

		return { "ok": true };
	} catch (error) {
		return { "ok": false, "reason": (error as { "code"?: string }).code ?? (error as Error).name };
	}
}

/**
 * Tell the owner, now, by email (OPERATIONS.md): the kill switch flipped, spend past its budget, the tripwire. To
 * ALERT_EMAIL (a secret); without it, or without a way to send here, only logged. Best effort: never fails its caller.
 */
export async function tellOwner(env: Bindings, subject: string, text: string): Promise<void> {
	const { log } = await import("./log.ts");

	if (env.ALERT_EMAIL === undefined || !canSend(env)) {
		log.warn("owner not emailed", { "subject": subject, "reason": env.ALERT_EMAIL === undefined ? "no ALERT_EMAIL" : "can't send here" });

		return;
	}

	const fill: Record<string, string> = { "subject": subject, "text": text, "environment": env.ENVIRONMENT, "admin": env.ENVIRONMENT === "production" ? "https://admin.unusuallygood.dev/" : "http://localhost:5174/" };
	const sent = await send(env, {
		"to": env.ALERT_EMAIL,
		"subject": `[unusually good ${env.ENVIRONMENT}] ${subject}`,
		"text": ALERT_TEXT.replaceAll(/\{\{(\w+)\}\}/gu, (_, key: string) => fill[key] ?? ""),
		"html": ALERT_HTML.replaceAll(/\{\{(\w+)\}\}/gu, (_, key: string) => escapeHtml(fill[key] ?? ""))
	});

	if ("reason" in sent) {
		log.warn("owner not emailed", { "subject": subject, "reason": sent.reason });
	}
}
