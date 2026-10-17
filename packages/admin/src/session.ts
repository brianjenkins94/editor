/**
 * The admin app's sign-in (README.md, "Admin sessions are separate from editor sessions"): util/auth/client as the
 * `admin` OAuth client, pushing its request first (PAR) and signing in through the API's own sign-in page. Its tokens
 * reach only /admin/*.
 */
import { createClient } from "@brianjenkins94/util/auth/client";

/** The API: production's for the production app; locally, the harness's (`npm run harness` in packages/api), unless
 *  VITE_API says otherwise (the dev deployment, say). */
export const API = location.hostname === "admin.unusuallygood.dev" ? "https://api.unusuallygood.dev" : (import.meta.env["VITE_API"] as string | undefined) ?? "http://localhost:8787";

/** Dispatched when the session ends under the app (revoked, or refused a refresh): it shows the sign-in again. */
export const SIGNED_OUT = "admin:signedOut";

export const session = createClient({ "api": API, "clientId": "admin", "redirectUri": () => `${location.origin}/`, "par": true, "tokensKey": "admin:session", "pendingKey": "admin:signIn", "database": "admin-session", "signedOutEvent": SIGNED_OUT });

/** A read from the admin API. */
export const get = async <T>(path: string): Promise<T> => session.json<T>(`/admin${path}`);
