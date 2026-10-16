import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { createMiddleware } from "hono/factory";
import { audit, origin } from "./audit.ts";

/**
 * Rate limits (README.md, "Hardening"), with the Workers Rate Limiting binding: checked before the work they guard, per
 * IP where nothing else names the caller, and per target (the grant a token names, the signed-in user) where something
 * does — distributed abuse rotates IPs, not targets. The binding counts per Cloudflare location and approximately: right
 * for stopping abuse, not for accounting. A request past a limit is a 429 and a `rate_limited` row (which alerts).
 * The limits themselves are in wrangler.jsonc's `ratelimits`.
 */

type Limiter = { [K in keyof Bindings]: Bindings[K] extends RateLimit ? K : never }[keyof Bindings];

/** The caller's IP, as Cloudflare saw it (`unknown` only outside Cloudflare, i.e. never deployed). */
export const byIp = (context: Context<AppEnv>): string => context.req.header("cf-connecting-ip") ?? "unknown";

/** The grant a `<grant id>.<secret>` code or refresh token in the form names, if it names one. */
export async function byGrant(context: Context<AppEnv>): Promise<string | undefined> {
	const form = await context.req.parseBody();
	const presented = form["code"] ?? form["refresh_token"] ?? form["token"];

	return typeof presented === "string" ? presented.split(".")[0] : undefined;
}

/** The signed-in user (after `session`). */
export const byUser = (context: Context<AppEnv>): string | undefined => context.get("user");

export function limit(limiter: Limiter, key: (context: Context<AppEnv>) => string | undefined | Promise<string | undefined>): MiddlewareHandler<AppEnv> {
	return createMiddleware<AppEnv>(async (context, next) => {
		const value = await key(context);

		if (value !== undefined && !(await context.env[limiter].limit({ "key": value })).success) {
			context.get("span").info("request refused", { "reason": `rate limit ${limiter}` });
			await audit(context.env, "rate_limited", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": limiter, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
			context.header("retry-after", "60");

			return context.json({ "error": "rate_limited" }, 429);
		}

		await next();
	});
}
