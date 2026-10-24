/**
 * Capabilities engine — what the capability IDE reads of a file, built on `@brianjenkins94/util/silo` (the canonical
 * static analysis). Every reading takes the `ts` and the SourceFile (and checker) of whatever holds the file — the
 * TypeScript server today, through the capabilities plugin; TypeScript 7.1's API connection later — so it parses
 * nothing itself and doesn't care which host it's in.
 *
 * - `findings`: the squiggles. Every capability call with a literal resource (`findReach`) — WHERE, WHAT it reaches, its
 *   callee and type — graded by `policy.isDangerous`, merged with what the canary (the dynamic half) observed: the
 *   concrete resource of a call whose argument isn't a literal. The capabilities extension publishes them.
 * - `surface`: a file's import surface, for the baseline's `consumer` (baseline.ts).
 * - `typesAt` and `statementsOf` (lib's `typed`): the types at a file's ranges (runtime evidence) and its statements as
 *   cards (projections).
 * - `purityOf` (lib's `purity`): each of a file's top-level functions pure, effectful or unknown — read lazily, one
 *   reader a program, so a function's verdict reads only what it reaches.
 */
import type { SurfaceEntry } from "@brianjenkins94/util/silo/detect";
import { surfaceEntries } from "@brianjenkins94/util/silo/detect";
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import { findReach, surfaceOf } from "@brianjenkins94/util/silo/reach";
import type { FilePurity } from "@brianjenkins94/util/silo/purity";
import { purityReader } from "@brianjenkins94/util/silo/purity";
import { typeAtStart } from "@brianjenkins94/util/silo/typed";

export { statementsOf, typesAt } from "@brianjenkins94/util/silo/typed";

/** One capability finding, as the extension shows it: its span, whether it's dangerous (a warning, else a hint), and
 *  what it says — `capability: callee → resource · type`. */
export interface Finding {
	"start": number;
	"end": number;
	"dangerous": boolean;
	"message": string;
}

/** What the canary (the plugin's dynamic half: tsval's, extensions/tsval/canary.ts, built beside the plugin) saw of a
 *  capability call as the module ran. */
interface CanaryObservation { "capability": string; "callee": string; "value": string; "observed": boolean; "static"?: string; "start": number; "end": number; "dangerous": boolean }

/** A finding's message: the static resource when it's a literal, else the canary's (`(ran)`), else that it needs a run;
 *  and its type, when the checker says one. */
function messageOf(capability: string, callee: string, resource: string | undefined, observation: CanaryObservation | undefined, type: string | undefined): string {
	let value = " → (unresolved — needs a run)";

	if (resource !== undefined) {
		value = " → " + resource;
	} else if (observation?.observed === true) {
		value = " → " + observation.value + " (ran)";
	}

	return `${capability}: ${callee}${value}${type === undefined || type === "" || type === "any" ? "" : " · " + type}`;
}

/** A file's capability findings: every call with a literal resource, typed by `checker`, and every call only the canary
 *  saw (`observations`, its run of this text) with the resource it ran with. */
// eslint-disable-next-line ts/no-explicit-any -- the host's `ts`, SourceFile and checker, as the plugin hands them over
export function findings(ts: any, sourceFile: any, checker: any, observations: readonly CanaryObservation[]): Finding[] {
	const found: Finding[] = [];
	const observed = new Map(observations.map((observation) => [observation.start, observation]));
	const statics = new Set<number>();

	for (const reach of findReach(ts, sourceFile)) {
		statics.add(reach.start);
		found.push({ "start": reach.start, "end": reach.end, "dangerous": isDangerous(reach.capability), "message": messageOf(reach.capability, reach.callee, reach.value, observed.get(reach.start), typeAtStart(ts, checker, sourceFile, reach.start)) });
	}

	// The calls only the canary saw: their resource wasn't a literal.
	for (const observation of observations) {
		if (!statics.has(observation.start)) {
			found.push({ "start": observation.start, "end": observation.end, "dangerous": observation.dangerous, "message": observation.observed ? `${observation.capability}: ${observation.callee} → ${observation.value} (ran)` : `${observation.capability}: ${observation.callee} → (ran; no string resource)` });
		}
	}

	return found;
}

/** Each program's purity reader: a program is the server's for one version of the files, so its verdicts hold for it. */
const readers = new WeakMap<object, ReturnType<typeof purityReader>>();

/** A file's top-level functions, each with its purity verdict and why (lib's `purity`). */
// eslint-disable-next-line ts/no-explicit-any -- the host's `ts`, program and SourceFile, as the plugin hands them over
export function purityOf(ts: any, program: any, sourceFile: any): FilePurity[] {
	let reader = readers.get(program);

	if (reader === undefined) {
		reader = purityReader(ts, program);
		readers.set(program, reader);
	}

	return reader.fileVerdicts(sourceFile);
}

/** One document's import surface — each specifier, the members its code uses of it (`dynamic`: some it can't name). */
// eslint-disable-next-line ts/no-explicit-any -- the host's `ts` and SourceFile, as the plugin hands them over
export function surface(ts: any, sourceFile: any): Record<string, SurfaceEntry> {
	return surfaceEntries(surfaceOf(ts, sourceFile));
}
