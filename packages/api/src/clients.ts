import type { Bindings } from "./env.ts";

/**
 * Our OAuth clients, in one table: each app that signs people in through this API. A new project is one entry here:
 * its name (what the sign-in page says it's signing you in to), the sign-in methods its page offers (README.md, "Sign-in methods"), and its
 * pages in each environment (`ENVIRONMENT` in wrangler.jsonc): the exact URLs a sign-in for it may come back to, matched
 * exactly (a link or a new passkey goes back to one of them by prefix, for a deep link or a hash route). The origins the
 * API answers browsers from are these pages' (`allowedOrigins`). In code, not config, as roles are (src/rbac.ts): a
 * client is reviewed like any other change. A client id that isn't a key here isn't one of ours.
 */

export type Method = "github" | "email" | "password" | "passkey";

type Environment = "local" | "dev" | "production";

interface Client { "name": string; "methods": Method[]; "pages": Record<Environment, string[]> }

export const CLIENTS = {
	"editor": {
		"name": "the editor",
		"methods": ["github", "email", "password", "passkey"],
		"pages": {
			"local": ["http://localhost:5173/", "http://editor.localhost:5173/"],
			"dev": ["https://brianjenkins94.github.io/editor/", "http://localhost:5173/", "http://editor.localhost:5173/"],
			"production": ["https://editor.unusuallygood.dev/"]
		}
	},
	// packages/admin; its dev server on 5174.
	"admin": {
		"name": "the admin app",
		"methods": ["github", "email", "password", "passkey"],
		"pages": {
			"local": ["http://localhost:5174/"],
			"dev": ["http://localhost:5174/"],
			"production": ["https://admin.unusuallygood.dev/"]
		}
	}
} satisfies Record<string, Client>;

export type ClientId = keyof typeof CLIENTS;

/** Whether `id` is one of our clients. */
export const isClient = (id: unknown): id is ClientId => typeof id === "string" && Object.hasOwn(CLIENTS, id);

const environment = (env: Bindings): Environment => (env.ENVIRONMENT === "dev" || env.ENVIRONMENT === "production" ? env.ENVIRONMENT : "local");

/** The pages a sign-in for `client` may come back to, here. None for a client that isn't ours. */
export const pagesOf = (env: Bindings, client: string): string[] => (isClient(client) ? CLIENTS[client].pages[environment(env)] : []);

/** What `client`'s sign-in page offers. Nothing for a client that isn't ours. */
export const methodsOf = (client: string): Method[] => (isClient(client) ? CLIENTS[client].methods : []);

/** The origins browsers may call this API from, here: every client's pages'. */
export const allowedOrigins = (env: Bindings): string[] => [...new Set(Object.values(CLIENTS).flatMap((client) => client.pages[environment(env)].map((page) => new URL(page).origin)))];
