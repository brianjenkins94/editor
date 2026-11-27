import type { Plugin } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import ts from "typescript";
import { instrument } from "../../almostnode/frameworks/instrument.ts";

const REPO = path.resolve(url.fileURLToPath(new URL("../../../", import.meta.url)));

const RUNTIME = `globalThis.__evidence ??= (() => { const modules = new Map(); const realm = Math.random().toString(36).slice(2); let channel; try { channel = new BroadcastChannel(${JSON.stringify("editor.coverage")}); channel.onmessage = ({ data }) => { if (data?.ask === "realms") { channel.postMessage({ answer: data.nonce, realm }); } else if (data?.ask === "ran" && data.realms?.includes(realm)) { const ran = {}; for (const { file, statements } of modules.values()) { for (const { start, end, count } of statements) { if (count > 0) { (ran[file] ??= []).push([start[0], end[0]]); } } } channel.postMessage({ answer: data.nonce, realm, ran }); } else if (data?.ask === "evidence") { const known = new Set(data.known ?? []); channel.postMessage({ answer: data.nonce, realm, modules: [...modules.values()].map(({ file, version, statements }) => ({ file, version, counts: statements.map(({ count }) => count), ...known.has(realm + "\\0" + file + "\\0" + version) ? {} : { statements: statements.map(({ start, end }) => [...start, ...end]) } })) }); } }; } catch {} return { module(file, version, table) { const key = file + "\\0" + version; let known = modules.get(key); if (known === undefined) { known = { file, version, statements: table.map(([kind, startLine, startCharacter, endLine, endCharacter]) => ({ kind, start: [startLine, startCharacter], end: [endLine, endCharacter], count: 0 })) }; modules.set(key, known); } return { s(site) { known.statements[site].count += 1; } }; }, publish() { try { channel?.postMessage({ answer: "published", realm, modules: [...modules.values()].map(({ file, version, statements }) => ({ file, version, counts: statements.map(({ count }) => count), statements: statements.map(({ start, end }) => [...start, ...end]) })) }); } catch {} }, evidence: () => [...modules.values()] }; })();`;

function ours(id: string): string | undefined {
	const file = id.split("?")[0];

	if (!file.startsWith(REPO + "/") || !/\.(m?[jt]sx?)$/u.test(file)) {
		return undefined;
	}

	const relative = file.slice(REPO.length + 1);
	const linked = /^.*node_modules\/(?:@brianjenkins94\/)?((?:almostnode|account|bablr|bablr-language-ts|editor-api|hub|observability|theme|tsval)\/.*)$/u.exec(relative);

	if ((relative.includes("node_modules/") && linked === null) || /\/(?:dist|test|fixtures)\//u.test(relative) || /\.test\.[mc]?[jt]sx?$/u.test(relative) || relative.endsWith("frameworks/instrument.ts") || relative === "packages/editor/shared/socket-gate.ts") {
		return undefined;
	}

	return linked === null ? relative : "packages/" + linked[1];
}

export function instrumented(code: string, id: string): string | undefined {
	const name = ours(id);

	if (name === undefined) {
		return undefined;
	}

	const sites = instrument(name, "cov", "coverage");
	const output = ts.transpileModule(code, { "fileName": name, "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ESNext, "jsx": ts.JsxEmit.Preserve, "allowJs": true, "verbatimModuleSyntax": false, "useDefineForClassFields": true }, "transformers": { "before": [sites.before] } }).outputText;
	const table = JSON.stringify(sites.sites().map((site) => [site.kind, ...site.start, ...site.end]));
	const identity = "(_, x) => x";
	const prelude = `${RUNTIME}const __ev = { ...globalThis.__evidence.module(${JSON.stringify(name)}, "cov", ${table}), v: ${identity}, b: ${identity}, a: ${identity}, o: ${identity}, c(_, __, x) { return x; }, p() {}, e() {}, k: ${identity}, x() {} };`;

	return `${prelude}\n${output}`;
}

export function coveragePlugin(): Plugin {
	return {
		"name": "coverage",
		"enforce": "pre",
		"transform": (code, id) => {
			const counted = instrumented(code, id);

			return counted === undefined ? undefined : { "code": counted, "map": null };
		}
	};
}

export const coverage = (): Plugin[] => (process.env["COVERAGE"] === "1" ? [coveragePlugin()] : []);

export function emittedAsIs(file: string): string {
	const code = fs.readFileSync(file, "utf8");

	return process.env["COVERAGE"] === "1" ? instrumented(code, file) ?? code : code;
}
