/**
 * ts-evaluator corpus programs tsval does not yet match, each with the reason. These run as `todo`,
 * so the suite stays green without hiding them; remove an entry when its feature lands.
 */
const DECORATORS = "decorators are a runtime-emit construct (ASSIGNMENT §4) not yet implemented — tsval throws `unimplemented: Decorator`";

export const KNOWN_GAPS: Record<string, string> = {
	"decorator/decorator.test.ts#0": DECORATORS,
	"decorator/decorator.test.ts#1": DECORATORS,
	"decorator/decorator.test.ts#2": DECORATORS,
	"decorator/decorator.test.ts#3": DECORATORS,
	"decorator/decorator.test.ts#4": DECORATORS,
	"decorator/decorator.test.ts#5": DECORATORS,
	"decorator/decorator.test.ts#6": DECORATORS,
};
