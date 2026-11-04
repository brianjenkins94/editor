import type { Plugin } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";
import { instrument } from "../../almostnode/frameworks/instrument.ts";

/**
 * COVERAGE=1 (off by default; build.ts): the editor's own modules instrumented for statement coverage with almostnode's
 * instrument.ts, counted in each realm by a small runtime of their own (RUNTIME), for the harness to read per test:
 * what each test ran, for comparing with what the ledger declares (packages/silo/README.md, *Declared against observed*).
 *
 * A stopgap (the ledger's *What each test ran*, an experiment): recording reach from outside the editor until tests run in
 * it, in the browser, where what a test ran is its trace.
 *
 * Files are named as the ledger names them, from the repository's root, whether a package was reached by its folder or
 * through node_modules.
 */
const REPO = path.resolve(url.fileURLToPath(new URL("../../../", import.meta.url)));

/** Each realm's counts, by module, on `globalThis.__evidence`: what test/architecture-harness.mjs reads. In every module's
 *  prelude, as a realm's first instrumented module may be any of them. */
const RUNTIME = `globalThis.__evidence ??= (() => { const modules = new Map(); return { module(file, version, table) { const key = file + "\\0" + version; let known = modules.get(key); if (known === undefined) { known = { file, version, statements: table.map(([kind, startLine, startCharacter, endLine, endCharacter]) => ({ kind, start: [startLine, startCharacter], end: [endLine, endCharacter], count: 0 })) }; modules.set(key, known); } return { s(site) { known.statements[site].count += 1; } }; }, evidence: () => [...modules.values()] }; })();`;

/** A module's repository-relative name when it's our code, else undefined (third party, built bundles, tests). */
function ours(id: string): string | undefined {
	const file = id.split("?")[0];

	if (!file.startsWith(REPO + "/") || !/\.(m?[jt]sx?)$/u.test(file)) {
		return undefined;
	}

	const relative = file.slice(REPO.length + 1);
	const linked = /^.*node_modules\/(?:@brianjenkins94\/)?((?:almostnode|account|bablr|bablr-language-ts|editor-api|hub|observability|theme|tsval)\/.*)$/u.exec(relative);

	if ((relative.includes("node_modules/") && linked === null) || /\/(?:dist|test|fixtures)\//u.test(relative) || /\.test\.[mc]?[jt]sx?$/u.test(relative) || relative.endsWith("frameworks/instrument.ts")) {
		return undefined;
	}

	return linked === null ? relative : "packages/" + linked[1];
}

export function coveragePlugin(): Plugin {
	return {
		"name": "coverage",
		"enforce": "pre",
		"transform": (code, id) => {
			const name = ours(id);

			if (name === undefined) {
				return undefined;
			}

			const instrumented = instrument(name, "cov", "coverage");
			const output = ts.transpileModule(code, { "fileName": name, "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ESNext, "jsx": ts.JsxEmit.Preserve, "allowJs": true, "verbatimModuleSyntax": false, "useDefineForClassFields": true }, "transformers": { "before": [instrumented.before] } }).outputText;
			const table = JSON.stringify(instrumented.sites().map((site) => [site.kind, ...site.start, ...site.end]));
			const identity = "(_, x) => x";
			const prelude = `${RUNTIME}const __ev = { ...globalThis.__evidence.module(${JSON.stringify(name)}, "cov", ${table}), v: ${identity}, b: ${identity}, a: ${identity}, o: ${identity}, c(_, __, x) { return x; }, p() {}, e() {}, k: ${identity}, x() {} };`;

			return { "code": `${prelude}\n${output}`, "map": null };
		}
	};
}
