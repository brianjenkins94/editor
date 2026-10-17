import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { SCHEMA as ATTEMPT } from "./attempt.ts";
import { PROXIED } from "./behavior.ts";
import { SCHEMA as GRANT } from "./grant.ts";
import { github } from "./github.ts";

/**
 * The API as it runs, described by itself (packages/admin/README.md, the architecture page): its routes (the router's own
 * table), its stores and their tables (D1's schema; each Durable Object class's, from the SQL that makes it), the GitHub
 * calls it relays (the proxy's templates), who may call it and what it calls. Zero-knowledge: names from the code and
 * counts, never a row. The deployment around it (the Workers, their hosts and bindings) is the admin app's to read from
 * the wrangler configs at build time.
 */

/** The router's routes, filled in by index.ts once they're all defined (the router can't be imported here: it imports
 *  the admin routes, this among them). */
export const ROUTES: { "method": string; "path": string }[] = [];

/** A schema's tables, by name, in order. */
const tablesOf = (schema: string): string[] => [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gu)].map((match) => match[1] as string);

/** GET /admin/architecture. */
export async function architectureEndpoint(context: Context<AppEnv>): Promise<Response> {
	const db = context.env.DB;
	const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name").all<{ "name": string }>();
	// How many rows each holds: a count, never a row. (COUNT reads the table; fine at this size, and only on request.)
	const counts = tables.length === 0 ? [] : await db.batch(tables.map(({ name }) => db.prepare(`SELECT COUNT(*) AS rows FROM "${name}"`)));
	const live = await db.prepare("SELECT COUNT(*) AS sessions FROM grants WHERE revoked_at IS NULL").first<{ "sessions": number }>();
	const origins = github(context.env);

	return context.json({
		"environment": context.env.ENVIRONMENT,
		"origin": new URL(context.req.url).origin,
		"routes": ROUTES,
		"database": tables.map(({ name }, index) => ({ "table": name, "rows": (counts[index]?.results[0] as { "rows": number } | undefined)?.rows ?? 0 })),
		"objects": [
			{ "binding": "GRANTS", "class": "Grant", "tables": tablesOf(GRANT), "live": live?.sessions ?? 0 },
			{ "binding": "ATTEMPTS", "class": "Attempt", "tables": tablesOf(ATTEMPT) }
		],
		"proxied": PROXIED.map((entry) => ({ "base": entry.base, "call": `${entry.method} ${entry.template}` })),
		"clients": context.env.ALLOWED_ORIGINS.split(","),
		"calls": {
			"github": { "web": origins.web, "api": origins.api },
			"analytics": context.env.ANALYTICS_TOKEN !== undefined && context.env.ANALYTICS_TOKEN !== "",
			"alerts": context.env.ALERT_WEBHOOK === undefined ? null : new URL(context.env.ALERT_WEBHOOK).host
		}
	});
}
