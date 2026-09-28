/**
 * ESLint engine — runs INSIDE the tsserver plugin worker (ts-plugin.js), so it reuses tsserver's OWN
 * `typescript` (the build aliases `typescript` → ts-external.js, which reads `globalThis.__eslintTs` set by the
 * plugin) instead of bundling its own ~6MB copy. This replaces the almostnode-hosted eslint LSP server: no
 * almostnode, no zen-fs, no separate worker — the linter runs where tsserver already loaded `ts`.
 *
 * Exposes `lintText(text, filename)`, which the plugin calls from `getSemanticDiagnostics`, and `fixText`, behind
 * the plugin's `_eslint.fixAll` request (fix-all on save / the formatter). It uses eslint's
 * `universal` (browser-safe, no node builtins) `Linter` + `@typescript-eslint/parser` with NO `project` option
 * (syntactic parse, no type info, no fs) — the same fixed flat config the old server used. Built by
 * eslint.engine.config.ts to a served URL (/__vscode__/lsp/eslint-engine.js), loaded by the plugin via a
 * native dynamic import.
 */
import * as tsParserModule from "@typescript-eslint/parser";
import { Linter } from "eslint/universal";
import { gatedEvalRealm } from "../../sandbox/gated-eval";

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
	/** Whether eslint can autofix this problem (it carries a `fix`) — `eslint.rules.customizations` can target these. */
	"fixable": boolean;
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
const builtinConfig = [{
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

// Whether the bundled Linter can run a rule. A workspace config's rules are filtered against this so an unknown,
// plugin, or type-aware rule can't abort `verify` (flat config throws when a rule/plugin is missing); such rules
// just don't run in-browser. The `universal` Linter has no `getRules()`, so probe: a trivial `verify` throws for an
// unknown rule and returns for a known one. Cached, since it runs per rule on each config change.
const knownRuleCache = new Map<string, boolean>();

function isKnownRule(id: string): boolean {
	const cached = knownRuleCache.get(id);
	if (cached !== undefined) {
		return cached;
	}

	let known: boolean;
	try {
		linter.verify("x;", [{ "rules": { [id]: "error" } }], { "filename": "probe.js" });
		known = true;
	} catch (error) {
		known = false;
	}

	knownRuleCache.set(id, known);

	return known;
}

// The active config: the built-in set until a workspace `eslint.config.*` is applied. Keyed by its source text so
// the (relatively expensive) transpile + evaluate only re-runs when the file actually changes.
let activeConfig: Linter.Config[] = builtinConfig;
let activeSource: string | undefined;

// Normalize an evaluated flat config into blocks the bundled Linter can run: always use the bundled TS parser, and
// keep only rules present in `coreRules`. Returns undefined when nothing usable survives (→ fall back to built-in).
function normalizeConfig(raw: unknown): Linter.Config[] | undefined {
	const blocks = Array.isArray(raw) ? raw : [raw];
	const out: Linter.Config[] = [];

	for (const block of blocks as Record<string, unknown>[]) {
		if (block === null || typeof block !== "object") {
			continue;
		}

		const rules: Record<string, unknown> = {};
		if (block.rules !== null && typeof block.rules === "object") {
			for (const [id, setting] of Object.entries(block.rules as Record<string, unknown>)) {
				if (isKnownRule(id)) rules[id] = setting;
			}
		}

		if (Object.keys(rules).length === 0) {
			continue;
		}

		const languageOptions: Record<string, unknown> = { "parser": tsParser };
		const source = block.languageOptions as Record<string, unknown> | undefined;
		if (source !== undefined && source !== null) {
			for (const key of ["parserOptions", "ecmaVersion", "sourceType", "globals"]) {
				if (source[key] !== undefined) languageOptions[key] = source[key];
			}
		}

		out.push({ "files": (block.files as string[]) ?? ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"], "languageOptions": languageOptions, "rules": rules } as Linter.Config);
	}

	return out.length > 0 ? out : undefined;
}

/** Apply the workspace `eslint.config.*`: transpile it, evaluate it in the capability-gated realm (no network/IO,
 *  returns data only), then normalize. Falls back to the built-in config when `text` is empty or evaluation fails.
 *  A no-op when `text` is unchanged. Async — the realm eval is off-thread; `activeConfig` swaps in when it resolves,
 *  so `lintText` stays synchronous and uses the previous config until then. */
export async function applyWorkspaceConfig(text: string | undefined): Promise<void> {
	if (text === activeSource) {
		return;
	}

	activeSource = text;

	if (text === undefined || text === "") {
		activeConfig = builtinConfig;

		return;
	}

	const ts = (globalThis as { "__eslintTs"?: typeof import("typescript") }).__eslintTs;
	const code = ts === undefined
		? text
		: ts.transpileModule(text, { "compilerOptions": { "module": ts.ModuleKind.CommonJS, "target": ts.ScriptTarget.ES2020 } }).outputText;

	const result = await gatedEvalRealm(code);

	// The config's source is untrusted; a capability attempt is an alarm, not a grant (well-behaved configs use none).
	if (result.attempts.length > 0) {
		console.warn("[eslint-engine] workspace eslint config attempted capabilities in the sandbox (denied):", result.attempts);
	}

	if (text !== activeSource) {
		return; // the config changed again while we were evaluating; a later call owns the result
	}

	if (result.error !== undefined) {
		console.error("[eslint-engine] workspace config evaluation failed, using built-in:", result.error);
		activeConfig = builtinConfig;

		return;
	}

	activeConfig = normalizeConfig(result.value) ?? builtinConfig;
}

/** Lint one document's text; returns [] on any failure so a bad file never breaks the checker pass. Messages
 *  are ordered errors-first (severity 2 before 1); the sort is stable, so source order is kept within a severity. */
export function lintText(text: string, filename: string): LintMessage[] {
	try {
		const messages = linter.verify(text, activeConfig, { "filename": filename }).map((message) => ({ ...message, "fixable": message.fix !== undefined }));

		return messages.sort((a, b) => b.severity - a.severity);
	} catch (error) {
		console.error("[eslint-engine] verify failed", error);

		return [];
	}
}

/** Apply every autofix eslint has for `text` (what the desktop extension's `source.fixAll.eslint` does), with the
 *  same active config as `lintText`. Returns the input unchanged (`fixed: false`) on failure. */
export function fixText(text: string, filename: string): { "output": string; "fixed": boolean } {
	try {
		const result = linter.verifyAndFix(text, activeConfig, { "filename": filename });

		return { "output": result.output, "fixed": result.fixed };
	} catch (error) {
		console.error("[eslint-engine] verifyAndFix failed", error);

		return { "output": text, "fixed": false };
	}
}
