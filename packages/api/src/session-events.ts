import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { origin } from "./audit.ts";
import { repositoryTag } from "./behavior.ts";
import { recordError } from "./errors.ts";
import { signedIn } from "./tokens.ts";

/**
 * What the editor reports (OPERATIONS.md, "Session timelines" and "Errors"; O6).
 *
 * `POST /session/events` (signed in only; signed out, nothing is recorded): a batch of what happened, in a fixed
 * vocabulary. Anything outside it is dropped, as is a detail of the wrong shape; a repository's name becomes the audit
 * log's keyed tag before it's kept. Onto the sign-in's timeline (its Grant).
 *
 * `POST /errors` (signed in or not): one of the editor's uncaught errors, recorded as the API's own are (src/errors.ts),
 * under an id the editor shows. Signed in, its user and sign-in, and an `error` event on the timeline; signed out,
 * nothing of who but the IP as the audit log's daily keyed hash. Ten a minute an IP.
 */

/** The vocabulary: each event's name, and what its detail may be (none, or a pattern). */
const VOCABULARY: Record<string, RegExp | null> = {
	"page.shown": null,
	"repo.loaded": /^[\w.-]{1,100}\/[\w.-]{1,100}$/u,
	"command.run": /^[\w.:/-]{1,120}$/u,
	"pane.opened": /^[\w.:/-]{1,120}$/u,
	"run.started": /^[\w-]{1,40}$/u,
	"run.ended": /^[\w-]{1,40}$/u,
	"error": /^E-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u
};

/** At most this many events a batch. */
const BATCH = 50;

/** How far back a batched event's own time is believed. */
const SKEW = 60_000;

/** POST /session/events: `{ events: [{ name, detail?, at? }] }`. Answers how many were kept. */
export async function sessionEventsEndpoint(context: Context<AppEnv>): Promise<Response> {
	const body = await context.req.json().catch(() => ({})) as { "events"?: unknown };
	const now = Date.now();
	const kept: { "at": number; "name": string; "detail": string | null }[] = [];

	for (const event of Array.isArray(body.events) ? body.events.slice(0, BATCH) : []) {
		const { name, detail, at } = (event ?? {}) as { "name"?: unknown; "detail"?: unknown; "at"?: unknown };

		if (typeof name !== "string" || !Object.hasOwn(VOCABULARY, name)) {
			continue;
		}

		const shape = VOCABULARY[name] ?? null;
		const allowed = shape !== null && typeof detail === "string" && shape.test(detail) ? detail : null;

		kept.push({
			"at": typeof at === "number" && at <= now && at >= now - SKEW ? at : now,
			"name": name,
			"detail": name === "repo.loaded" && allowed !== null ? await repositoryTag(context.env, allowed) : allowed
		});
	}

	if (kept.length > 0) {
		await context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant"))).recordEditor(kept);
	}

	return context.json({ "kept": kept.length });
}

/** The realms an error can come from (observability's sources), and anything else as "editor". */
const SOURCES = /^(?:shell|host|root|workbench|bridge|worker|node|tap|preview)[\w:-]{0,40}$/u;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** POST /errors: `{ name, message, stack?, source?, release?, breadcrumbs? }`; answers `{ id }`. */
export async function editorErrorEndpoint(context: Context<AppEnv>): Promise<Response> {
	const body = await context.req.json().catch(() => ({})) as Record<string, unknown>;
	const name = text(body["name"], 100) || "Error";
	const source = typeof body["source"] === "string" && SOURCES.test(body["source"]) ? body["source"] : "editor";
	// Signed in, if a sign-in comes with it and holds; otherwise anonymous (an error report never fails on a token).
	const signed = context.req.header("authorization") === undefined ? undefined : await signedIn(context).catch(() => undefined);
	const who = signed === undefined || signed instanceof Response || signed.client !== "editor" ? undefined : signed;
	const breadcrumbs = Array.isArray(body["breadcrumbs"]) ? body["breadcrumbs"].filter((crumb): crumb is string => typeof crumb === "string" && Object.hasOwn(VOCABULARY, crumb)).slice(-10) : [];
	const id = await recordError(context.env, {
		"source": "editor",
		"name": name,
		"message": text(body["message"], 2000),
		"stack": typeof body["stack"] === "string" ? body["stack"].slice(0, 8000) : undefined,
		"route": `editor ${source}`,
		"release": typeof body["release"] === "string" && /^[\w.-]{1,40}$/u.test(body["release"]) ? body["release"] : "unknown",
		"traceId": (context.get("span") as { "traceId"?: string } | undefined)?.traceId ?? null,
		"grantId": who?.grant ?? null,
		"userId": who?.user ?? null,
		"ipHash": who === undefined ? (await origin(context)).ipHash : null,
		"breadcrumbs": breadcrumbs
	});

	if (who !== undefined) {
		await context.env.GRANTS.get(context.env.GRANTS.idFromString(who.grant)).recordEditor([{ "at": Date.now(), "name": "error", "detail": id }]);
	}

	context.header("cache-control", "no-store");

	return context.json({ "id": id });
}
