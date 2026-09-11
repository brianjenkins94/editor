/**
 * Pre-build patch: let almostnode's dynamic `import()` resolve `file://` URLs against its VFS.
 *
 * almostnode rewrites `import(x)` to `__dynamicImport(x)`, which just calls its `require(x)` — so a dynamic
 * import only resolves for a plain VFS path (`/work/eslint.config.js`), not a `file://` URL. Tools that load
 * modules via `import(pathToFileURL(path).href)` therefore fail — notably eslint's flat-config loader, which
 * imports `import(pathToFileURL(configPath).href + "?mtime=…")`. This normalizes a `file://` specifier (strip
 * the scheme, any `?query`/`#hash`, a Windows drive slash, percent-encoding) back to the VFS path before
 * almostnode resolves it, so `import()` of a config/plugin file resolves from the VFS (which we back with
 * zen-fs). Verified end-to-end: eslint loads its flat config from the VFS and lints.
 *
 * Patches the INSTALLED dep (index.mjs + index.cjs), so it runs before the builds that bundle almostnode
 * (and is idempotent, re-applied after `npm install`). If almostnode's shape changes so the anchor no longer
 * matches, it FAILS LOUDLY rather than silently shipping an un-patched (eslint-broken) runtime.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const MARKER = "/* file-url import patched */";
// `function createDynamicImport(<req>) { return async (<spec>) => {` — capture the two identifiers so the
// inserted normalization uses the real (possibly re-minified) param names.
const anchorRe = /(function createDynamicImport\((\w+)\)\s*\{\s*return async \((\w+)\)\s*=>\s*\{)/u;

const distDir = path.dirname(createRequire(import.meta.url).resolve("almostnode"));
const targets = ["index.mjs", "index.cjs"].map((name) => path.join(distDir, name)).filter((file) => existsSync(file));

if (targets.length === 0) {
	throw new Error(`patch-almostnode: no index.mjs/.cjs found in ${distDir} — is almostnode installed?`);
}

let patchedCount = 0;

for (const file of targets) {
	const code = readFileSync(file, "utf8");

	if (code.includes(MARKER)) {
		console.log(`patch-almostnode: ${path.basename(file)} already patched`);
		patchedCount += 1;
		continue;
	}

	const next = code.replace(anchorRe, (full, _sig, _req, spec) =>
		`${full}${MARKER}if(typeof ${spec}==="string"&&${spec}.startsWith("file://")){let __p=${spec}.slice(7);const __q=__p.search(/[?#]/);if(__q!==-1)__p=__p.slice(0,__q);if(__p.startsWith("/")&&__p[2]===":")__p=__p.slice(1);try{__p=decodeURIComponent(__p);}catch{}${spec}=__p;}`);

	if (next === code) {
		throw new Error(`patch-almostnode: could not find createDynamicImport in ${path.basename(file)} — upstream shape changed; update the patch`);
	}

	writeFileSync(file, next);
	console.log(`patch-almostnode: patched ${path.basename(file)} (file:// dynamic import → VFS path)`);
	patchedCount += 1;
}

console.log(`patch-almostnode: done (${patchedCount}/${targets.length} file(s))`);
