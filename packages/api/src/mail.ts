import type { Bindings } from "./env.ts";

/**
 * Sending email (SIGN-IN.md, C2): through Cloudflare Email Service's `send_email` binding (`EMAIL`), from our own
 * address on the zone (its SPF, DKIM and DMARC records are Email Service's to keep). In the harness and the tests,
 * through an outbox stand-in instead (`EMAIL_OUTBOX`, a URL the message is POSTed to as JSON), so nothing leaves the
 * machine and a test can read what was sent.
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
