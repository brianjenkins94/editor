import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import type { AuthenticatorTransport } from "@simplewebauthn/server";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { audit, origin } from "./audit.ts";
import { emailOf, githubIdOf } from "./identities.ts";
import { field, isAppPage, recent, refuse } from "./link.ts";
import { heldAttempt, signInAs } from "./signin.ts";

/**
 * Passkeys (SIGN-IN.md, "Passkeys"): WebAuthn, through @simplewebauthn/server. The relying party is the API's own host
 * (api.unusuallygood.dev, the dev worker's, localhost), not the whole site, so only our sign-in page's origin can ask for
 * one: never an app's, nor a preview's. A passkey signs in on its own (it's a device and a PIN or a face, user
 * verification required), and such a sign-in can hold a role (src/rbac.ts).
 *   POST /account/passkey            (the app, signed in) `return`: our passkey page to go to, its options and a ticket
 *   POST /passkey/register           (that page) `ticket`, `credential`: checked, held; back to the app's page with `passkey`
 *   POST /account/passkey/finish     (the app) `passkey`: added
 *   POST /account/passkey/remove     (the app) `id`
 *   POST /auth/passkey/options       (the sign-in page) a challenge for this browser's attempt
 *   POST /auth/passkey               (the sign-in page) `credential`: the sign-in
 * Adding is three steps for the same reason connecting GitHub is (src/link.ts): the passkey is created on our page, not
 * the app's, and only the sign-in that asked can finish adding it.
 */

const RP_NAME = "unusually good";

/** Our relying party: the host and origin this request reached, which is the sign-in page's. */
const party = (context: Context<AppEnv>): { "rpID": string; "origin": string } => {
	const url = new URL(context.req.url);

	return { "rpID": url.hostname, "origin": url.origin };
};

/** A passkey as stored, and as the account page lists it. */
interface Row { "id": string; "public_key": string; "counter": number; "transports": string | null; "backed_up": number; "created_at": number; "last_used_at": number | null; "user_id": string }

/** The user's passkeys, for the account page: when added and last used, and whether each syncs. */
export async function passkeysOf(env: AppEnv["Bindings"], user: string): Promise<{ "id": string; "createdAt": number; "lastUsedAt": number | null; "synced": boolean }[]> {
	const { results } = await env.DB.prepare("SELECT id, created_at, last_used_at, backed_up FROM passkeys WHERE user_id = ? ORDER BY created_at").bind(user).all<Row>();

	return results.map((row) => ({ "id": row.id, "createdAt": row.created_at, "lastUsedAt": row.last_used_at, "synced": row.backed_up === 1 }));
}

/** POST /account/passkey: `return` (one of the app's pages). Our page to make the passkey on, with its options. */
export async function passkeyStartEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const returnTo = field(await context.req.parseBody(), "return");

	if (!isAppPage(context, returnTo)) {
		return refuse(context, 400, "return", "not one of the app's pages");
	}

	const refused = await recent(context, "add a passkey");

	if (refused !== undefined) {
		return refused;
	}

	const { rpID, origin: ours } = party(context);
	const githubId = await githubIdOf(context.env, user);
	const { results: existing } = await context.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(user).all<Pick<Row, "id" | "transports">>();
	const options = await generateRegistrationOptions({
		"rpName": RP_NAME,
		"rpID": rpID,
		// What the device shows the passkey as: the account's email, or its GitHub id (we keep no login), or ours.
		"userName": await emailOf(context.env, user) ?? (githubId === null ? user : `GitHub user ${githubId}`),
		"userID": isoBase64URL.toBuffer(isoBase64URL.fromUTF8String(user)),
		"attestationType": "none",
		"excludeCredentials": existing.map((row) => ({ "id": row.id, "transports": row.transports === null ? undefined : JSON.parse(row.transports) as AuthenticatorTransport[] })),
		"authenticatorSelection": { "residentKey": "required", "userVerification": "required" }
	});
	const started = await context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant"))).startPasskey(options.challenge, returnTo);

	if (started === undefined) {
		return refuse(context, 400, "signed_out", "this sign-in is over");
	}

	context.header("cache-control", "no-store");

	return context.json({ "location": `${ours}/passkey#${new URLSearchParams({ "ticket": started.ticket, "options": JSON.stringify(options) })}` });
}

/** POST /passkey/register (our passkey page): `ticket` and the new `credential` (JSON), checked against the ticket's
 *  challenge, our origin and host; held for the app, whose page the browser goes back to with the code. */
export async function passkeyRegisterEndpoint(context: Context<AppEnv>): Promise<Response> {
	const form = await context.req.parseBody();
	const ticket = field(form, "ticket");
	const [grantId = ""] = ticket.split(".");
	let grant: DurableObjectStub<import("./grant.ts").Grant>;

	try {
		grant = context.env.GRANTS.get(context.env.GRANTS.idFromString(grantId));
	} catch {
		return context.json({ "error": "ticket", "reason": "that page has expired: add the passkey again" }, 400);
	}

	const setup = await grant.passkeySetup(ticket);

	if (setup === undefined) {
		return context.json({ "error": "ticket", "reason": "that page has expired: add the passkey again" }, 400);
	}

	const { rpID, origin: ours } = party(context);
	const checked = await verifyRegistrationResponse({ "response": JSON.parse(field(form, "credential") || "{}") as Parameters<typeof verifyRegistrationResponse>[0]["response"], "expectedChallenge": setup.challenge, "expectedOrigin": ours, "expectedRPID": rpID, "requireUserVerification": true }).catch(() => undefined);

	if (checked?.verified !== true) {
		context.get("span").info("passkey refused", { "reason": "registration didn't verify" });

		return context.json({ "error": "credential", "reason": "that passkey couldn't be checked: try again" }, 400);
	}

	const { credential, aaguid, credentialBackedUp } = checked.registrationInfo;
	const held = await grant.setUpPasskey(ticket, JSON.stringify({ "id": credential.id, "publicKey": isoBase64URL.fromBuffer(credential.publicKey), "counter": credential.counter, "transports": credential.transports ?? null, "aaguid": aaguid, "backedUp": credentialBackedUp }));

	if (held === undefined) {
		return context.json({ "error": "ticket", "reason": "that page has expired: add the passkey again" }, 400);
	}

	const back = new URL(setup.returnTo);

	back.searchParams.set("passkey", held.code);
	context.header("cache-control", "no-store");

	return context.json({ "location": back.href });
}

/** POST /account/passkey/finish: `passkey` (the code our page sent back), through the sign-in that asked: added. */
export async function passkeyFinishEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const held = await context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant"))).takePasskey(field(await context.req.parseBody(), "passkey"));

	if (held === undefined) {
		return refuse(context, 400, "passkey", "that passkey has expired: add it again");
	}

	const credential = JSON.parse(held) as { "id": string; "publicKey": string; "counter": number; "transports": string[] | null; "aaguid": string; "backedUp": boolean };
	const added = await context.env.DB.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, aaguid, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(credential.id, user, credential.publicKey, credential.counter, credential.transports === null ? null : JSON.stringify(credential.transports), credential.aaguid, credential.backedUp ? 1 : 0, Date.now()).run();

	if (added.meta.changes !== 1) {
		return refuse(context, 409, "taken", "that passkey is added already");
	}

	await audit(context.env, "passkey_added", { "userId": user, "grantId": context.get("grant") }, await origin(context), { "reason": credential.backedUp ? "synced" : "this device only" });
	context.header("cache-control", "no-store");

	return context.json({ "added": true, "id": credential.id });
}

/** POST /account/passkey/remove: `id`, one of the user's passkeys. Needs a sign-in in the last 10 minutes. */
export async function passkeyRemoveEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const refused = await recent(context, "remove a passkey");

	if (refused !== undefined) {
		return refused;
	}

	const removed = await context.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(field(await context.req.parseBody(), "id"), user).run();

	if (removed.meta.changes !== 1) {
		return refuse(context, 400, "passkey", "no such passkey on this account");
	}

	await audit(context.env, "passkey_removed", { "userId": user, "grantId": context.get("grant") }, await origin(context));

	return context.json({ "removed": true });
}

/** A sign-in page refusal, recorded. */
async function refused(context: Context<AppEnv>, status: 400 | 401, error: string, reason: string): Promise<Response> {
	context.get("span").info("sign-in refused", { "reason": reason });
	await audit(context.env, "sign_in_refused", {}, await origin(context), { "reason": `passkey: ${reason}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	context.header("cache-control", "no-store");

	return context.json({ "error": error, "reason": reason }, status);
}

/** POST /auth/passkey/options: a challenge for this browser's attempt, and what the browser asks the passkey with. Any of
 *  the person's passkeys for our host (discoverable: no account named first). */
export async function passkeyOptionsEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = heldAttempt(context);

	if (held === undefined) {
		return refused(context, 401, "no_attempt", "no sign-in in progress in this browser");
	}

	const options = await generateAuthenticationOptions({ "rpID": party(context).rpID, "userVerification": "required" });
	const kept = await held.stub.challenged(held.secret, options.challenge);

	if ("reason" in kept) {
		return refused(context, 401, "no_attempt", kept.reason);
	}

	context.header("cache-control", "no-store");

	return context.json(options);
}

/** POST /auth/passkey: `credential` (the passkey's answer, JSON), checked against the attempt's challenge and the
 *  passkey it names; its sign count kept; then the sign-in ("passkey"), as an emailed code's or a password's ends. */
export async function passkeySignInEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = heldAttempt(context);

	if (held === undefined) {
		return refused(context, 401, "no_attempt", "no sign-in in progress in this browser");
	}

	const challenge = await held.stub.takeChallenge(held.secret);

	if ("reason" in challenge) {
		return refused(context, 400, "challenge", "ask the passkey again");
	}

	const response = JSON.parse(field(await context.req.parseBody(), "credential") || "{}") as Parameters<typeof verifyAuthenticationResponse>[0]["response"];
	const row = typeof response.id === "string" ? await context.env.DB.prepare("SELECT p.id, p.user_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.deleted_at IS NULL").bind(response.id).first<Row>() : null;

	if (row === null) {
		return refused(context, 400, "unknown", "that passkey isn't one of ours: sign in another way");
	}

	const { rpID, origin: ours } = party(context);
	const checked = await verifyAuthenticationResponse({ "response": response, "expectedChallenge": challenge.challenge, "expectedOrigin": ours, "expectedRPID": rpID, "requireUserVerification": true, "credential": { "id": row.id, "publicKey": isoBase64URL.toBuffer(row.public_key), "counter": row.counter, "transports": row.transports === null ? undefined : JSON.parse(row.transports) as string[] } }).catch(() => undefined);

	if (checked?.verified !== true) {
		return refused(context, 400, "credential", "that passkey couldn't be checked: try again");
	}

	await context.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(checked.authenticationInfo.newCounter, Date.now(), row.id).run();

	return signInAs(context, held, row.user_id, "passkey");
}
