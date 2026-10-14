/**
 * Capabilities engine — the STATIC half of the capability IDE, built on `@brianjenkins94/util/silo` (the canonical
 * static analysis). `findReach` reads the file off TypeScript's tree — the SourceFile tsserver already holds, with
 * tsserver's own `ts`, so the engine parses nothing itself — and returns every capability call with a literal resource
 * — WHERE it is (source span), WHAT it reaches, and its `callee` — while `policy.isDangerous` grades the capability.
 *
 * Static means every such call is reported, whether or not it executes; a call whose resource isn't a literal is the
 * canary's (the dynamic half), which observes the concrete pre-call value.
 *
 * Loaded INSIDE the capabilities tsserver plugin (ts-plugin.js), which enriches each row's `type` from tsserver's
 * checker before publishing native diagnostics.
 */
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import { findReach } from "@brianjenkins94/util/silo/reach";

export interface CapabilityRow {
	/** Capability class: net / fs / fs:read / fs:write / exec / env / eval. */
	"capability": string;
	/** The call/member expression text (e.g. "fetch", "fs.readFileSync"). */
	"callee": string;
	/** The statically-resolved resource (URL / path / command / env key), or a placeholder when unresolvable. */
	"value": string;
	/** Whether the resource resolved statically (false → the dynamic canary is needed to see the real value). */
	"resolved": boolean;
	/** Source span of the whole finding node, for anchoring to the document. */
	"start": number;
	"end": number;
	/** Whether the capability is dangerous enough to gate (silo policy) — drives the diagnostic severity. */
	"dangerous": boolean;
	/** The real-checker type of the expression, filled by the plugin (undefined until then). */
	"type"?: string;
}

/** Analyze one document's capability surface, statically: every reached capability call with its span, resolved
 *  value, and danger grade. `ts` is tsserver's own module, `sourceFile` its SourceFile of the document. */
// eslint-disable-next-line ts/no-explicit-any -- tsserver's `ts` and SourceFile, as the plugin hands them over
export function analyze(ts: any, sourceFile: any): CapabilityRow[] {
	return findReach(ts, sourceFile).map((reach) => ({
		"capability": reach.capability,
		"callee": reach.callee,
		"value": reach.value,
		// (every static row's resource is a literal: that's what findReach captures)
		"resolved": true,
		"start": reach.start,
		"end": reach.end,
		"dangerous": isDangerous(reach.capability)
	}));
}
