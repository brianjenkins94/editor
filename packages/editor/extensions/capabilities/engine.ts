/**
 * Capabilities engine — the STATIC half of the capability IDE, built on `@brianjenkins94/util/silo` (the
 * canonical static analysis; the root `src/` prototype is superseded). `findReach` walks the file with oxc and
 * returns every capability call — WHERE it is (source span), WHAT it reaches (the statically-resolved value),
 * and its `callee` — while `policy.isDangerous` grades the capability. This runs unchanged in the browser
 * because silo's reach/detect are pure oxc + AST logic (oxc's wasm binding is bundled by build.ts).
 *
 * Static means EVERY capability call is reported, whether or not it executes — the canary (the dynamic half,
 * built next) will enrich these with concrete pre-call values for the ones static can't resolve.
 *
 * Loaded INSIDE the capabilities tsserver plugin (ts-plugin.js), which anchors each row's span to the real
 * SourceFile and enriches its `type` from tsserver's checker before publishing native diagnostics.
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
 *  value, and danger grade. */
export function analyze(src: string, fileName: string): CapabilityRow[] {
	return findReach(fileName, src).map((reach) => ({
		"capability": reach.capability,
		"callee": reach.callee,
		"value": reach.value,
		"resolved": reach.safe !== false,
		"start": reach.start,
		"end": reach.end,
		"dangerous": isDangerous(reach.capability)
	}));
}
