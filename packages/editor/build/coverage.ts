import type { Plugin } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";
import { instrument } from "../../almostnode/frameworks/instrument.ts";

/**
 * COVERAGE=1 (off by default; build.ts): the editor's own modules instrumented for statement coverage with almostnode's
 * instrument.ts — what the preview dev server does to a workspace's modules — counted in each realm by the preview's own
 * runtime (previews/page-evidence.ts installPageEvidence), for reading per architecture test: the harness keeps each
 * session's realms; reading them per test comes with selecting tests by reach (NEXT.md).
 *
 * A module looks the runtime up when its first statement runs, not as it loads: whichever realm it's in, the runtime's
 * module may be evaluated after it.
 */
const REPO = path.resolve(url.fileURLToPath(new URL("../../../", import.meta.url)));
const RUNTIME = "\0coverage-runtime";
const PAGE_EVIDENCE = url.fileURLToPath(new URL("../previews/page-evidence.ts", import.meta.url));

/** Repo-relative name of a module that's our code, else undefined (third party, built bundles, tests, the taps). */
function ours(id: string): string | undefined {
	const file = id.split("?")[0];

	if (!file.startsWith(REPO + "/") || !/\.(m?[jt]sx?)$/u.test(file)) {
		return undefined;
	}

	const rel = file.slice(REPO.length + 1);
	const vendored = rel.includes("node_modules/") && !rel.includes("node_modules/@brianjenkins94/");

	if (vendored || /\/(dist|test|fixtures|previews)\//u.test(rel) || /\.test\.[mc]?[jt]sx?$/u.test(rel) || rel.endsWith("frameworks/instrument.ts")) {
		return undefined;
	}

	return rel.replace(/^.*node_modules\/@brianjenkins94\//u, "@brianjenkins94/");
}

export function coveragePlugin(): Plugin {
	return {
		"name": "coverage",
		"enforce": "pre",
		"resolveId": (source) => (source === RUNTIME ? RUNTIME : undefined),
		"load": (id) => (id === RUNTIME ? `import { installPageEvidence } from ${JSON.stringify(PAGE_EVIDENCE)};\nif (globalThis.__evidence === undefined) { installPageEvidence(() => undefined); }\n` : undefined),
		"transform": (code, id) => {
			const rel = ours(id);

			if (rel === undefined) {
				return undefined;
			}

			const instrumented = instrument(rel, "cov", "coverage");
			const output = ts.transpileModule(code, { "fileName": rel, "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ESNext, "jsx": ts.JsxEmit.Preserve, "allowJs": true, "verbatimModuleSyntax": false, "useDefineForClassFields": true }, "transformers": { "before": [instrumented.before] } }).outputText;
			const table = JSON.stringify(instrumented.sites().map((site) => [site.kind, ...site.start, ...site.end]));
			const prelude = `import ${JSON.stringify(RUNTIME)};const __ev = (() => { let m; const get = () => (m ??= globalThis.__evidence?.module(${JSON.stringify(rel)}, "cov", ${table})); const id = (_, x) => x; return { s(i) { get()?.s(i); }, v: id, b: id, a: id, o: id, c(_, __, x) { return x; }, p() {}, e() {}, k: id, x() {} }; })();`;

			return { "code": `${prelude}\n${output}`, "map": null };
		}
	};
}
