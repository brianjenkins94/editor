/**
 * ESLint engine — runs INSIDE the tsserver plugin worker (ts-plugin.js), so it reuses tsserver's OWN
 * `typescript` (the build aliases `typescript` → ts-external.js, which reads `globalThis.__eslintTs` set by the
 * plugin) instead of bundling its own ~6MB copy. This replaces the almostnode-hosted eslint LSP server: no
 * almostnode, no zen-fs, no separate worker — the linter runs where tsserver already loaded `ts`.
 *
 * Exposes ONE `lintText(text, filename)` the plugin calls from `getSemanticDiagnostics`. It uses eslint's
 * `universal` (browser-safe, no node builtins) `Linter` + `@typescript-eslint/parser` with NO `project` option
 * (syntactic parse, no type info, no fs) — the same fixed flat config the old server used. Built by
 * eslint.engine.config.ts to a served URL (/__vscode__/lsp/eslint-engine.js), loaded by the plugin via a
 * native dynamic import.
 */
import * as tsParserModule from "@typescript-eslint/parser";
import { Linter } from "eslint/universal";

const linter = new Linter();

/** A lint message as the plugin needs it — 1-based positions, to convert to TS diagnostic offsets. */
export interface LintMessage {
	"line": number;
	"column": number;
	"endLine"?: number;
	"endColumn"?: number;
	"message": string;
	"severity": number;
	"ruleId": string | null;
}

// The parser object eslint needs (has parseForESLint/parse). Bundlers differ on CJS/ESM default interop —
// @typescript-eslint/parser may land on the module namespace or its `.default` — so pick whichever actually
// carries the parse functions. (Its own `require("typescript")` resolves to the ts-external shim.)
function resolveParser(module: Record<string, unknown>): Linter.Parser {
	for (const candidate of [module.default, module] as Record<string, unknown>[]) {
		if (candidate !== undefined && (typeof candidate.parseForESLint === "function" || typeof candidate.parse === "function")) {
			return candidate as unknown as Linter.Parser;
		}
	}

	throw new Error("[eslint-engine] @typescript-eslint/parser has no parse/parseForESLint export");
}

const tsParser = resolveParser(tsParserModule);

// A small, universally-applicable flat config (carried over verbatim from the retired server-node-eslint.ts).
// `files` must match (relative to the cwd basePath) or eslint reports "No matching configuration found" instead
// of linting. @typescript-eslint/parser (no `project` option → syntactic parsing, no type info, no fs) lets
// these rules run on TypeScript as well as JavaScript.
const config = [{
	"files": ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
	"languageOptions": { "parser": tsParser },
	// A small set of rules that work on TS with only the parser (no type info): syntactic checks, no `no-undef`
	// (it can't see TS types/globals — typescript-eslint disables it for TS).
	"rules": {
		"prefer-const": "error",
		"no-debugger": "error",
		"no-var": "error",
		"no-constant-condition": "warn",
		"no-empty": "warn"
	}
}] satisfies Linter.Config[];

/** Lint one document's text; returns [] on any failure so a bad file never breaks the checker pass. Messages
 *  are ordered errors-first (severity 2 before 1); the sort is stable, so source order is kept within a severity. */
export function lintText(text: string, filename: string): LintMessage[] {
	try {
		const messages = linter.verify(text, config, { "filename": filename }) as LintMessage[];

		return messages.sort((a, b) => b.severity - a.severity);
	} catch (error) {
		console.error("[eslint-engine] verify failed", error);

		return [];
	}
}
