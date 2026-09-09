/**
 * ts-evaluator corpus programs tsval does not match, in two distinct categories:
 *
 * - KNOWN_GAPS: features inside the supported surface that aren't implemented yet. Run as `todo` —
 *   reported, never silently passing, visible the moment they start to pass.
 * - OUT_OF_SCOPE: features tsval refuses by policy (not standard / not erasable TypeScript / sloppy-
 *   mode only — see README "Supported surface"). Skipped with the reason; tsval throws loudly on them.
 */
export const KNOWN_GAPS: Record<string, string> = {};

const LEGACY_DECORATORS = "legacy (experimentalDecorators) decorators are non-standard; tsval refuses decorators loudly";
const PARAMETER_PROPERTIES = "parameter properties are non-erasable TypeScript; tsval refuses them loudly";

export const OUT_OF_SCOPE: Record<string, string> = {
	"decorator/decorator.test.ts#0": LEGACY_DECORATORS,
	"decorator/decorator.test.ts#1": LEGACY_DECORATORS,
	"decorator/decorator.test.ts#2": LEGACY_DECORATORS,
	"decorator/decorator.test.ts#3": LEGACY_DECORATORS,
	"decorator/decorator.test.ts#4": LEGACY_DECORATORS,
	"decorator/decorator.test.ts#5": LEGACY_DECORATORS,
	"decorator/decorator.test.ts#6": LEGACY_DECORATORS,
	"class-declaration/class-declaration.test.ts#10": PARAMETER_PROPERTIES
};
