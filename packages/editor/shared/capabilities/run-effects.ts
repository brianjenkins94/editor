/**
 * Each run's effects (util/silo/evidence's `Effect`), by run id, until its envelope is written (`run.effects`): each
 * capability and resource once per way it went, with how many calls went that way — those the editor decided itself (a
 * preview's gate, decide.ts; a file call through the runtime, runtime-fs.ts: recordEffect) apart from those a debugger
 * tells (its `effects` event, debug-events.ts: setEffects, each telling all of them). Pure.
 */
import type { Effect } from "@brianjenkins94/util/silo/evidence";

const runEffects = new Map<string, Map<string, Effect>>();
const toldEffects = new Map<string, Map<string, Effect>>();

function count(store: Map<string, Map<string, Effect>>, runId: string, capability: string, resource: string, how: Effect["how"], calls: number, pkg?: string): void {
	let effects = store.get(runId);

	if (effects === undefined) {
		effects = new Map();
		store.set(runId, effects);
	}

	// (a package's call apart from the program's same call)
	const key = `${how}\0${capability}\0${resource}\0${pkg ?? ""}`;
	const known = effects.get(key);

	if (known === undefined) {
		effects.set(key, { "capability": capability, "resource": resource, "how": how, "calls": calls, ...pkg === undefined ? {} : { "package": pkg } });
	} else {
		known.calls += calls;
	}
}

/** A gated call `runId` made that the editor decided (a preview's, as its gate decides each; a file call through the
 *  runtime, runtime-fs.ts), and how it went. */
export function recordEffect(runId: string, capability: string, resource: string, how: Effect["how"], calls = 1): void {
	count(runEffects, runId, capability, resource, how, calls);
}

/** Every gated call `runId` made so far that its debugger decided, as it tells them (the run contract's `effects`
 *  event: each telling has them all), in place of what it told before. */
export function setEffects(runId: string, effects: readonly Effect[]): void {
	toldEffects.delete(runId);

	for (const effect of effects) {
		count(toldEffects, runId, effect.capability, effect.resource, effect.how, effect.calls, effect.package);
	}
}

/** `runId`'s effects, taken (as its envelope is written: `run.effects`) — the editor's and its debugger's together; made
 *  first, then denied, skipped, given. */
export function takeEffects(runId: string): Effect[] {
	const merged = new Map<string, Map<string, Effect>>();

	for (const store of [runEffects, toldEffects]) {
		for (const effect of store.get(runId)?.values() ?? []) {
			count(merged, runId, effect.capability, effect.resource, effect.how, effect.calls, effect.package);
		}

		store.delete(runId);
	}

	const effects = [...merged.get(runId)?.values() ?? []];
	const order = ["made", "denied", "skipped", "given"];

	return effects.toSorted((left, right) => order.indexOf(left.how) - order.indexOf(right.how) || left.capability.localeCompare(right.capability) || left.resource.localeCompare(right.resource) || (left.package ?? "").localeCompare(right.package ?? ""));
}
