import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import type { Provider } from "./identities.ts";
import { checkActionCode, issueActionCode } from "./action-codes.ts";
import { audit, origin } from "./audit.ts";
import { ADDRESS } from "./email.ts";
import { authorizeUrl } from "./github.ts";
import { githubIdOf, identityOf, link, ownerOf } from "./identities.ts";

/**
 * Linking (SIGN-IN.md, "Linking accounts"): another way to sign in, added to the signed-in account. GitHub connected to
 * an account made by email; an email added to a GitHub account. Only while signed in, after a sign-in in the last 10
 * minutes (the action's own check: a stolen session can't quietly add its own way in), and each proven by its own check:
 * GitHub's authorize page, a code to the address. Never automatically by a matching address. A way in that's another
 * account's already is merged in if that account holds nothing but it (`mergeable`), and the person says so (`merge`);
 * otherwise refused, saying whose.
 *   POST /account/github           `return` (the app's page): GitHub's authorize page, to go to
 *   POST /account/github/finish    `link` (the code GitHub's callback sent back), `merge`
 *   POST /account/email/code       `address`: a code to it
 *   POST /account/email            `address`, `code`, `merge`
 * The editor reaches them at the API's root, the admin app under /admin (src/index.ts, src/admin.ts).
 */

const RECENT = 10 * 60_000;

const ADD_EMAIL = "add_email";

const PROVIDERS: Record<Provider, string> = { "github": "GitHub account", "email": "email" };

export async function refuse(context: Context<AppEnv>, status: 400 | 403 | 409, error: string, reason: string, extra: Record<string, unknown> = {}): Promise<Response> {
	context.get("span").info("link refused", { "reason": reason });
	await audit(context.env, "auth_refused", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": `link: ${reason}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	context.header("cache-control", "no-store");

	return context.json({ "error": error, "reason": reason, ...extra }, status);
}

/** The action's own check: this sign-in was made in the last 10 minutes. The refusal, or nothing. */
export async function recent(context: Context<AppEnv>, what: string): Promise<Response | undefined> {
	const grant = await context.env.DB.prepare("SELECT created_at FROM grants WHERE id = ?").bind(context.get("grant")).first<{ "created_at": number }>();

	return grant === null || Date.now() - grant.created_at > RECENT ? refuse(context, 403, "sign_in_again", `sign in again to ${what} (it needs a sign-in in the last 10 minutes)`) : undefined;
}

/** Whether `other` holds nothing but its `provider` way in: no other, no password, passkey or two-factor, no role (a GitHub id in
 *  OWNERS or VIEWERS). Such an account can be merged into another; anything more is someone's to keep. */
async function mergeable(env: Bindings, other: string, provider: Provider): Promise<boolean> {
	const row = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM identities WHERE user_id = ?) AS ways,
		(SELECT COUNT(*) FROM passwords WHERE user_id = ?) + (SELECT COUNT(*) FROM totp WHERE user_id = ?) + (SELECT COUNT(*) FROM email_mfa WHERE user_id = ?) + (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) AS kept`).bind(other, other, other, other, other).first<{ "ways": number; "kept": number }>();

	if (row === null || row.ways !== 1 || row.kept !== 0) {
		return false;
	}

	const githubId = provider === "github" ? await githubIdOf(env, other) : null;

	return githubId === null || (!env.OWNERS.includes(githubId) && !(env.VIEWERS ?? []).includes(githubId));
}

/**
 * Attach `subject` to the signed-in user: linked; already theirs; or another account's, merged in when that account is
 * mergeable and `merge` says so (its sign-ins ended, the account deleted as account deletion does: purged after 30
 * days), else refused with whose it is and whether it could be merged. The refusal, or nothing.
 */
async function attach(context: Context<AppEnv>, provider: Provider, subject: string, merge: boolean): Promise<Response | undefined> {
	const user = context.get("user");
	const from = await origin(context);
	const now = Date.now();
	const other = await ownerOf(context.env, provider, subject);

	if (other === user) {
		return undefined;
	}

	if (other === undefined) {
		if (await link(context.env, user, provider, subject, now)) {
			await audit(context.env, "identity_linked", { "userId": user, "grantId": context.get("grant") }, from, { "reason": provider });

			return undefined;
		}

		return refuse(context, 409, "taken", `that ${PROVIDERS[provider]} was just linked to another account`);
	}

	const canMerge = await mergeable(context.env, other, provider);

	if (!merge || !canMerge) {
		return refuse(context, 409, "taken", `that ${PROVIDERS[provider]} is another account's`, { "account": other, "mergeable": canMerge });
	}

	const { results } = await context.env.DB.prepare("SELECT id FROM grants WHERE user_id = ? AND revoked_at IS NULL").bind(other).all<{ "id": string }>();

	for (const { id } of results) {
		await context.env.GRANTS.get(context.env.GRANTS.idFromString(id)).revoke({ "from": from, "reason": "account merged into another" });
	}

	await context.env.DB.batch([
		context.env.DB.prepare("UPDATE identities SET user_id = ?, verified_at = ? WHERE user_id = ? AND provider = ?").bind(user, now, other, provider),
		context.env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(now, other)
	]);
	await audit(context.env, "account_merged", { "userId": other, "grantId": context.get("grant") }, from, { "reason": `its ${PROVIDERS[provider]} moved to another account`, "detail": `into ${user}; purged after 30 days` });
	await audit(context.env, "identity_linked", { "userId": user, "grantId": context.get("grant") }, from, { "reason": provider, "detail": `merged from ${other}` });

	return undefined;
}

export const field = (form: Record<string, unknown>, name: string): string => (typeof form[name] === "string" ? form[name] : "");

/** Whether `returnTo` is one of the signed-in app's own pages (its REDIRECT_URIS, as a prefix: a deep link, or the page's
 *  hash route): the only places a link or a new passkey goes back to. */
export const isAppPage = (context: Context<AppEnv>, returnTo: string): boolean => URL.canParse(returnTo) && (context.env.REDIRECT_URIS[context.get("client")] ?? []).some((page) => returnTo.startsWith(page));

/** POST /account/github: where to go to connect GitHub — GitHub's authorize page, coming back to `return` (one of the
 *  app's own pages) with a code this sign-in finishes. */
export async function githubLinkEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const returnTo = field(await context.req.parseBody(), "return");

	if (await githubIdOf(context.env, user) !== null) {
		return refuse(context, 409, "linked", "a GitHub account is connected already");
	}

	if (!isAppPage(context, returnTo)) {
		return refuse(context, 400, "return", "not one of the app's pages");
	}

	const refused = await recent(context, "connect GitHub");

	if (refused !== undefined) {
		return refused;
	}

	context.header("cache-control", "no-store");

	return context.json({ "location": await authorizeUrl(context, { "link": context.get("grant"), "returnTo": returnTo }) });
}

/** POST /account/github/finish: `link` (from GitHub's way back) attaches that GitHub account (attach), and its tokens
 *  become this sign-in's, so the editor reaches GitHub through the proxy at once. */
export async function githubFinishEndpoint(context: Context<AppEnv>): Promise<Response> {
	const form = await context.req.parseBody();
	const code = field(form, "link");
	const grant = context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant")));
	const githubId = code === "" ? undefined : await grant.heldGithubLink(code);

	if (githubId === undefined) {
		return refuse(context, 400, "link", "that link has expired: connect GitHub again");
	}

	const refused = await attach(context, "github", String(githubId), field(form, "merge") === "1");

	if (refused !== undefined) {
		return refused;
	}

	await grant.takeGithubLink(code);
	context.header("cache-control", "no-store");

	return context.json({ "linked": "github", "githubId": githubId });
}

/** POST /account/email/code: `address`, for an account without one: a code to it. */
export async function emailLinkCodeEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const address = field(await context.req.parseBody(), "address");

	if (await identityOf(context.env, user, "email") !== null) {
		return refuse(context, 409, "linked", "this account has an email already");
	}

	if (address.length > 254 || !ADDRESS.test(address)) {
		return refuse(context, 400, "address", "that isn't an email address");
	}

	const refused = await recent(context, "add an email") ?? await issueActionCode(context, user, ADD_EMAIL, `${user}:${ADD_EMAIL}:${address.toLowerCase()}`, address, "add this email to your account", "auth_refused");

	if (refused !== undefined) {
		return refused;
	}

	context.header("cache-control", "no-store");

	return context.json({ "sent": true, "address": address });
}

/** POST /account/email: `address` and its `code` attach the address (attach); the code spent once it's done. */
export async function emailLinkEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const form = await context.req.parseBody();
	const address = field(form, "address");
	const refused = await checkActionCode(context, user, ADD_EMAIL, `${user}:${ADD_EMAIL}:${address.toLowerCase()}`, field(form, "code"), "auth_refused")
		?? await attach(context, "email", address, field(form, "merge") === "1");

	if (refused !== undefined) {
		return refused;
	}

	await context.env.DB.prepare("DELETE FROM action_codes WHERE user_id = ? AND action = ?").bind(user, ADD_EMAIL).run();
	context.header("cache-control", "no-store");

	return context.json({ "linked": "email", "address": address });
}
