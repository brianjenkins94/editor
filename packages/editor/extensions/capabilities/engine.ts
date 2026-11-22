import type { SurfaceEntry } from "@brianjenkins94/util/silo/detect";
import { surfaceEntries } from "@brianjenkins94/util/silo/detect";
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import { findReach, surfaceOf } from "@brianjenkins94/util/silo/reach";
import { typeAtStart } from "@brianjenkins94/util/silo/typed";

export interface Finding {
	"start": number;
	"end": number;
	"dangerous": boolean;
	"message": string;
	"capability": string;
	"resource"?: string;
}

interface CanaryObservation { "capability": string; "callee": string; "value": string; "observed": boolean; "static"?: string; "start": number; "end": number; "dangerous": boolean }

function messageOf(capability: string, callee: string, resource: string | undefined, observation: CanaryObservation | undefined, type: string | undefined): string {
	let value = " → (unresolved — needs a run)";

	if (resource !== undefined) {
		value = " → " + resource;
	} else if (observation?.observed === true) {
		value = " → " + observation.value + " (ran)";
	}

	return `${capability}: ${callee}${value}${type === undefined || type === "" || type === "any" ? "" : " · " + type}`;
}

function resourceOf(resource: string | undefined, observation: CanaryObservation | undefined): { "resource"?: string } {
	const known = resource ?? (observation?.observed === true ? observation.value : undefined);

	return known === undefined ? {} : { "resource": known };
}

// eslint-disable-next-line ts/no-explicit-any -- the host's `ts`, SourceFile and program, as the plugin hands them over
export function findings(ts: any, sourceFile: any, program: any, observations: readonly CanaryObservation[]): Finding[] {
	const checker = program.getTypeChecker();
	const found: Finding[] = [];
	const observed = new Map(observations.map((observation) => [observation.start, observation]));
	const statics = new Set<number>();

	for (const reach of findReach(ts, sourceFile, undefined, program)) {
		statics.add(reach.start);
		found.push({ "start": reach.start, "end": reach.end, "dangerous": isDangerous(reach.capability), "message": messageOf(reach.capability, reach.callee, reach.value, observed.get(reach.start), typeAtStart(ts, checker, sourceFile, reach.start)), "capability": reach.capability, ...resourceOf(reach.value, observed.get(reach.start)) });
	}

	for (const observation of observations) {
		if (!statics.has(observation.start)) {
			found.push({ "start": observation.start, "end": observation.end, "dangerous": observation.dangerous, "message": observation.observed ? `${observation.capability}: ${observation.callee} → ${observation.value} (ran)` : `${observation.capability}: ${observation.callee} → (ran; no string resource)`, "capability": observation.capability, ...resourceOf(undefined, observation) });
		}
	}

	return found;
}

// eslint-disable-next-line ts/no-explicit-any -- whatever host's `ts` and tree (the server's, through the plugin)
export function surface(ts: any, sourceFile: any): Record<string, SurfaceEntry> {
	return surfaceEntries(surfaceOf(ts, sourceFile));
}
