import type { Plugin, RollupOutput } from "vite";
import { createHash } from "node:crypto";
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

export type Level = "coverage" | "full";

export const levelOf = (setting = process.env["COVERAGE"]): Level | undefined => {
	if (setting === "full") {
		return "full";
	}

	return setting === "1" ? "coverage" : undefined;
};

export const RUNTIME_ID = "virtual:editor-evidence";

export function blobOid(code: string): string {
	return createHash("sha1").update(`blob ${String(Buffer.byteLength(code))}\0`).update(code).digest("hex");
}

export function instrumented(code: string, id: string, level: Level = "coverage"): string | undefined {
	const name = ours(id);

	if (name === undefined) {
		return undefined;
	}

	const version = blobOid(code);
	const sites = instrument(name, version, level);
	const output = ts.transpileModule(code, { "fileName": name, "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ESNext, "jsx": ts.JsxEmit.Preserve, "allowJs": true, "verbatimModuleSyntax": false, "useDefineForClassFields": true }, "transformers": { "before": [sites.before] } }).outputText;

	if (level === "full") {
		return `import ${JSON.stringify(RUNTIME_ID)};\n${sites.prelude()}\n${output}`;
	}

	const table = JSON.stringify(sites.sites().map((site) => [site.kind, ...site.start, ...site.end]));
	const identity = "(_, x) => x";
	const prelude = `${RUNTIME}const __ev = { ...globalThis.__evidence.module(${JSON.stringify(name)}, ${JSON.stringify(version)}, ${table}), v: ${identity}, b: ${identity}, a: ${identity}, o: ${identity}, c(_, __, x) { return x; }, p() {}, e() {}, k: ${identity}, x() {} };`;

	return `${prelude}\n${output}`;
}

let runtime: Promise<string> | undefined;

export async function bundledRuntime(): Promise<string> {
	const { build } = await import("vite");
	const output = await build({
		"configFile": false,
		"logLevel": "silent",
		"root": url.fileURLToPath(new URL("..", import.meta.url)),
		"build": {
			"write": false,
			"minify": false,
			"target": "esnext",
			"lib": { "entry": url.fileURLToPath(new URL("../previews/editor-evidence.ts", import.meta.url)), "formats": ["iife"], "name": "editor_evidence", "fileName": "editor-evidence" },
			"rollupOptions": { "output": { "codeSplitting": false } }
		}
	}) as RollupOutput[];

	return output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";
}

export function coveragePlugin(level: Level = "coverage"): Plugin {
	return {
		"name": "coverage",
		"enforce": "pre",
		"resolveId": (source) => (source === RUNTIME_ID ? "\0" + RUNTIME_ID : undefined),
		"load": async (id) => {
			if (id !== "\0" + RUNTIME_ID) {
				return undefined;
			}

			runtime ??= bundledRuntime();

			return runtime;
		},
		"transform": (code, id) => {
			const counted = instrumented(code, id, level);

			return counted === undefined ? undefined : { "code": counted, "map": null };
		}
	};
}

export const coverage = (): Plugin[] => {
	const level = levelOf();

	return level === undefined ? [] : [coveragePlugin(level)];
};

export function emittedAsIs(file: string): string {
	const code = fs.readFileSync(file, "utf8");

	return levelOf() === undefined ? code : instrumented(code, file) ?? code;
}
