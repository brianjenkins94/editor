/**
 * test262 tests tsval does not pass yet, grouped by id PREFIX (a directory or file) with the reason.
 * Matching tests run as `todo`: reported, never silently passing, visible the moment they pass.
 * Keep entries as narrow as the bug they describe; remove them as fixes land.
 */
const YIELD_IN_SUBEXPRESSION =
	"`yield` inside a computed property name / destructuring target: those sub-expressions are evaluated synchronously (VM.evalNodeSync), so a suspension inside them is refused loudly (TsvalInternalError) rather than modeled";

export const TEST262_KNOWN_GAPS: Record<string, string> = {
	"statements/class/accessor-name-static-computed-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-of/dstr/array-elem-nested-array-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-of/dstr/array-rest-iter-rtrn-close.js": YIELD_IN_SUBEXPRESSION,
	// `for await` destructuring targets containing `yield` — same limitation; the refusal surfaces as a
	// rejected `next()` the test never observes, so these time out rather than fail fast.
	"statements/for-await-of/async-gen-decl-dstr-array-elem-target-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-array-rest-nested-array-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-array-rest-nested-obj-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-array-rest-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-obj-id-init-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-obj-prop-elem-init-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-obj-prop-elem-target-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-obj-prop-nested-array-yield-expr.js": YIELD_IN_SUBEXPRESSION,
	"statements/for-await-of/async-gen-decl-dstr-obj-prop-nested-obj-yield-expr.js": YIELD_IN_SUBEXPRESSION,
};

/** Find the gap entry covering an id (longest matching prefix wins). */
export function knownGap(id: string): string | undefined {
	let best: string | undefined;
	let bestLen = -1;
	for (const [prefix, reason] of Object.entries(TEST262_KNOWN_GAPS)) {
		if (id.startsWith(prefix) && prefix.length > bestLen) {
			best = reason;
			bestLen = prefix.length;
		}
	}
	return best;
}
