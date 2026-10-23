import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.ts";
import { Hono } from "hono";
import { emailLinkCodeEndpoint, emailLinkEndpoint, githubFinishEndpoint, githubLinkEndpoint } from "./link.ts";
import { emailMfaCodeEndpoint, emailMfaEndpoint, mfaConfirmEndpoint, mfaOffEndpoint, mfaRecoveryEndpoint, mfaStartEndpoint } from "./mfa.ts";
import { passkeyFinishEndpoint, passkeyRemoveEndpoint, passkeyStartEndpoint } from "./passkeys.ts";
import { accountEndpoint, passwordCodeEndpoint, setPasswordEndpoint } from "./password.ts";

/**
 * Your account's routes (README.md, "Sign-in methods"): how you sign in, a password, two-factor, linking, passkeys. One table, mounted for
 * the editor at /account with its session in front of each route (`signedIn`; src/index.ts, where /account/delete sits
 * beside them with its own) and for the admin app at /admin/account, behind the admin session it applies to everything
 * (src/admin.ts). The handlers read only the signed-in user and sign-in, so they're the same for both. Any token of
 * either client, roles or none: it's your own account. Each change has its own check (a code to your email, or a
 * sign-in in the last 10 minutes), in its handler.
 */
export function accountRoutes(signedIn: MiddlewareHandler<AppEnv> = async (_context, next) => {
	await next();
}): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.get("/", signedIn, accountEndpoint);

	// A password (C3): a code to your email, then the password.
	routes.post("/password/code", signedIn, passwordCodeEndpoint);

	routes.post("/password", signedIn, setPasswordEndpoint);

	// Two-factor (C5): set up (start, then confirm with the app's code), turned off, new recovery codes.
	routes.post("/mfa/start", signedIn, mfaStartEndpoint);

	routes.post("/mfa/confirm", signedIn, mfaConfirmEndpoint);

	routes.post("/mfa/off", signedIn, mfaOffEndpoint);

	routes.post("/mfa/recovery", signedIn, mfaRecoveryEndpoint);

	// Two-factor by email (C6): a code to your email, then on or off.
	routes.post("/mfa/email/code", signedIn, emailMfaCodeEndpoint);

	routes.post("/mfa/email", signedIn, emailMfaEndpoint);

	// Linking another way to sign in (src/link.ts): GitHub, an email.
	routes.post("/github", signedIn, githubLinkEndpoint);

	routes.post("/github/finish", signedIn, githubFinishEndpoint);

	routes.post("/email/code", signedIn, emailLinkCodeEndpoint);

	routes.post("/email", signedIn, emailLinkEndpoint);

	// Passkeys (src/passkeys.ts): added through our passkey page, removed.
	routes.post("/passkey", signedIn, passkeyStartEndpoint);

	routes.post("/passkey/finish", signedIn, passkeyFinishEndpoint);

	routes.post("/passkey/remove", signedIn, passkeyRemoveEndpoint);

	return routes;
}
