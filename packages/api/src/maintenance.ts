import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { createMiddleware } from "hono/factory";
import { audit, NOWHERE } from "./audit.ts";
import { tellOwner } from "./mail.ts";

/**
 * The kill switch (OPERATIONS.md, "The kill switch"): one D1 row, read at most every 10 seconds per isolate, so turning
 * it on reaches every request within seconds, costs one read per isolate per 10 seconds, and needs no deploy. On, the
 * API answers "Down for maintenance" before doing anything else, except what the owner needs to look and turn it off:
 * the admin app's sign-in by GitHub or a passkey, and /admin/* for the owner role (src/admin.ts).
 *
 * Whoever flips it (the owner from the admin app, the cost guard, the tripwire, or `npm run maintenance` through
 * wrangler), the row records who and why, unnoticed; the first Worker to read it notices, once (a conditional update),
 * and audits the flip and emails the owner. So every flip is recorded the same way, however it was made.
 */

export interface Maintenance { "on": boolean; "reason": string | null; "by": string | null; "at": number | null }

const TTL = 10_000;

const OFF: Maintenance = { "on": false, "reason": null, "by": null, "at": null };

/** What the public is told. The reason is the owner's (the admin app shows it), not everyone's. */
const DOWN = "Down for maintenance";

let cached: { "state": Maintenance; "until": number } | undefined;

/** A flip just made: audited (`maintenance_on`, `maintenance_off`, by whom, why) and the owner emailed, by the one reader
 *  whose conditional update marks it noticed. */
async function notice(env: Bindings, state: Maintenance): Promise<void> {
	const marked = await env.DB.prepare("UPDATE maintenance SET noticed = 1 WHERE id = 1 AND noticed = 0 AND at IS ?").bind(state.at).run();

	if (marked.meta.changes !== 1) {
		return;
	}

	const user = state.by?.startsWith("user:") === true ? state.by.slice("user:".length) : undefined;

	await audit(env, state.on ? "maintenance_on" : "maintenance_off", user === undefined ? {} : { "userId": user }, NOWHERE, { "reason": state.reason ?? undefined, "detail": `by ${state.by ?? "unknown"}` });
	await tellOwner(env, state.on ? "The API is down for maintenance" : "The API is back up", [
		state.on ? "The kill switch is on: the API answers \"Down for maintenance\" to everything but your sign-in to the admin app." : "The kill switch is off: the API answers as usual.",
		`Why: ${state.reason ?? "no reason given"}`,
		`By: ${state.by ?? "unknown"}`,
		state.on ? "Turn it off from the admin app, or: npm run maintenance -- off --env <environment> (in packages/api)." : ""
	].filter((line) => line !== "").join("\n"));
}

/** The switch, as of at most 10 seconds ago; a flip not yet noticed is noticed now. */
export async function maintenance(env: Bindings): Promise<Maintenance> {
	const now = Date.now();

	if (cached !== undefined && cached.until > now) {
		return cached.state;
	}

	// Unreadable (D1 itself down, say): open, logged. A switch that can't be read mustn't turn every request into an error;
	// what it protects needs D1 too.
	const row = await env.DB.prepare("SELECT switched_on, reason, by, at, noticed FROM maintenance WHERE id = 1").first<{ "switched_on": number; "reason": string | null; "by": string | null; "at": number | null; "noticed": number }>().catch(async (error: unknown) => {
		const { log } = await import("./log.ts");

		log.error("maintenance switch unreadable", { "error": error instanceof Error ? error.message : String(error) });

		return null;
	});
	const state = row === null ? OFF : { "on": row.switched_on === 1, "reason": row.reason, "by": row.by, "at": row.at };

	cached = { "state": state, "until": now + TTL };

	if (row !== null && row.noticed === 0) {
		await notice(env, state);
	}

	return state;
}

/** Flip it: `by` is who or what ("user:<id>", "cost guard", "tripwire"). Noticed (audited, the owner emailed) at once
 *  here, and seen by every other isolate within 10 seconds. */
export async function setMaintenance(env: Bindings, on: boolean, reason: string | null, by: string): Promise<Maintenance> {
	await env.DB.prepare("UPDATE maintenance SET switched_on = ?, reason = ?, by = ?, at = ?, noticed = 0 WHERE id = 1").bind(on ? 1 : 0, reason, by, Date.now()).run();
	cached = undefined;

	return maintenance(env);
}

/** The answer while it's on: 503, the public reason, try again in five minutes. */
export function down(context: Context<AppEnv>): Response {
	context.header("retry-after", "300");
	context.header("cache-control", "no-store");

	return context.json({ "error": "maintenance", "reason": DOWN }, 503);
}

/** The routes the owner's way back in needs: reading our keys and metadata, the admin client's sign-in (the attempt
 *  routes serve only attempts opened for it while the switch is on), signing out, the switch's own status, and /admin/*
 *  (which lets only the owner role through, src/admin.ts). */
const OPEN = new Set(["/health", "/status", "/auth/attempt", "/auth/github", "/auth/github/callback", "/auth/passkey/options", "/auth/passkey", "/revoke"]);

async function ownersWay(context: Context<AppEnv>): Promise<boolean> {
	const path = new URL(context.req.url).pathname;

	if (OPEN.has(path) || path.startsWith("/.well-known/") || path === "/admin" || path.startsWith("/admin/")) {
		return true;
	}

	// Starting a sign-in, and the token endpoint: the admin client's only.
	if (path === "/auth/start") {
		return context.req.query("client_id") === "admin";
	}

	if ((path === "/auth/par" || path === "/token") && context.req.method === "POST") {
		return (await context.req.parseBody())["client_id"] === "admin";
	}

	return false;
}

/** Before anything else: while the switch is on, everything but the owner's way back in is down. */
export const maintenanceGate = createMiddleware<AppEnv>(async (context, next) => {
	if ((await maintenance(context.env)).on && !await ownersWay(context)) {
		context.get("span").info("request refused", { "reason": "maintenance" });

		return down(context);
	}

	await next();
});
