/**
 * TypeScript compiler-test cases on which tsval and Node still disagree, by id PREFIX, with the
 * reason. Matching cases run as `todo`: reported, never silently passing, visible when they pass.
 */
const FUNCTION_SOURCE_TEXT = "Function.prototype.toString of a guest class/function returns the host wrapper's source, not the guest source text";

export const TS_CASES_KNOWN_GAPS: Record<string, string> = {
	"compiler/concatClassAndString.ts": FUNCTION_SOURCE_TEXT,
	"conformance/es6/templates/templateStringsWithTypeErrorInFunctionExpressionsInSubstitutionExpression": FUNCTION_SOURCE_TEXT,
	"compiler/classNameReferencesInStaticElements.ts": "the ORACLE deviates: tsc's emit rewrites class-name references inside static elements to a temp assigned after the class (TypeScript #54607), so Node sees `undefined` in a static block where native semantics (and tsval) see the class"
};

export function knownGap(id: string): string | undefined {
	let best: string | undefined;
	let bestLen = -1;

	for (const [prefix, reason] of Object.entries(TS_CASES_KNOWN_GAPS)) {
		if (id.startsWith(prefix) && prefix.length > bestLen) {
			best = reason;
			bestLen = prefix.length;
		}
	}

	return best;
}
