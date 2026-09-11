/**
 * Post-build patch: let the WEB-WORKER extension host load ESM entrypoints.
 *
 * Upstream monaco-vscode-api's web-worker ext host refuses ESM outright — `_loadESMModule` is just
 * `throw Error("ESM modules are not supported in the web worker extension host")` (see CodinGame/
 * monaco-vscode-api#818). The CJS path right next to it already resolves the entry to a browser URI
 * (`<X>.revive(await this.<proxy>.$asBrowserUri(module))`) and then fetch+evals it. This rewrites
 * `_loadESMModule` to reuse that SAME resolution and `import()` the URI instead of eval-ing — which makes
 * ESM extensions activate and gives them a working `import.meta.url`.
 *
 * Runs after `vite build` (the built worker is a hashed asset). It's idempotent, and it derives the
 * minified `revive`/proxy tokens from the CJS method in the same file, so it survives re-minification; if
 * upstream changes shape enough that the anchors no longer match, it FAILS LOUDLY rather than silently
 * shipping an un-patched (ESM-broken) worker. Remove this once #818 is fixed upstream.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const assetsDir = url.fileURLToPath(new URL("./dist/assets", import.meta.url));
const workers = readdirSync(assetsDir).filter((name) => /^extensionHost\.worker-.*\.js$/u.test(name));

if (workers.length === 0) {
	throw new Error("patch-esm-ext-host: no extensionHost.worker-*.js found in dist/assets — did vite build run?");
}

const MARKER = "/* esm-ext-host patched */";
const throwRe = /_loadESMModule\(([\w$]+),([\w$]+),([\w$]+)\)\{throw Error\(`ESM modules are not supported in the web worker extension host`\)\}/u;
// The CJS loader's resolution: `<reviveNs>.revive(await <proxy>.$asBrowserUri(` — reused verbatim.
const resolveRe = /([\w$]+)\.revive\(await (this\.[\w$]+)\.\$asBrowserUri\(/u;

let patchedCount = 0;

for (const name of workers) {
	const file = path.join(assetsDir, name);
	let code = readFileSync(file, "utf8");

	if (code.includes(MARKER)) {
		console.log(`patch-esm-ext-host: ${name} already patched`);
		patchedCount += 1;
		continue;
	}

	const resolveMatch = resolveRe.exec(code);

	if (resolveMatch === null) {
		throw new Error(`patch-esm-ext-host: could not find the CJS $asBrowserUri resolution in ${name} — upstream shape changed; update the patch`);
	}

	const [, reviveNs, proxy] = resolveMatch;

	const next = code.replace(throwRe, (_full, p1, p2, p3) =>
		`_loadESMModule(${p1},${p2},${p3}){${MARKER}return ${proxy}.$asBrowserUri(${p2}).then((u)=>import(${reviveNs}.revive(u).toString(!0)))}`);

	if (next === code) {
		throw new Error(`patch-esm-ext-host: could not find _loadESMModule's throw in ${name} — upstream shape changed; update the patch`);
	}

	writeFileSync(file, next);
	console.log(`patch-esm-ext-host: patched ${name} (import() ESM entrypoints via ${proxy}.$asBrowserUri)`);
	patchedCount += 1;
}

console.log(`patch-esm-ext-host: done (${patchedCount}/${workers.length} worker file(s))`);
