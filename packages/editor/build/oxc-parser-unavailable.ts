/**
 * `oxc-parser` in the LSP workers' bundle: lib's util/silo/detect imports it for surfaceOfSource, which the package
 * worker never calls — packageCaps is regular expressions — so its native binding isn't bundled (build.ts aliases it
 * here). Whatever does call it is told why it can't.
 */
export function parseSync(): never {
	throw new Error("oxc-parser isn't in the LSP workers' bundle: util/silo/detect's surfaceOfSource runs where it is (silo, the capabilities engine)");
}
