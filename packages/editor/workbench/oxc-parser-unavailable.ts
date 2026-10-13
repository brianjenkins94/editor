/**
 * `oxc-parser` in the workbench bundle: lib's util/silo/detect imports it for surfaceOfSource, which the workbench never
 * calls — baseline.ts uses detect, which is regular expressions — so its native binding isn't bundled (build.ts aliases
 * it here). Whatever does call it is told why it can't.
 */
export function parseSync(): never {
	throw new Error("oxc-parser isn't in the workbench bundle: util/silo/detect's surfaceOfSource runs where it is (silo, the capabilities engine)");
}
