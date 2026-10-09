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
import presetData from "eslint:preset";
import presetPlugins from "eslint:preset-plugins";
import { createRequire } from "node:module";
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

// A small, universally-applicable flat config — the base only if the preset below yields nothing (no plugin loaded
// and no blocks). `files` must match (relative to the cwd basePath) or eslint reports "No matching configuration
// found" instead of linting. @typescript-eslint/parser (no `project` option → syntactic parsing, no type info, no
// fs) lets these rules run on TypeScript as well as JavaScript.
const fallbackConfig = [{
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

// ── The preset base, loaded plugin by plugin ─────────────────────────────────────────────────────────────────
//
// The user's shared preset (@brianjenkins94/util/eslint), extracted at build time into data + one loader per plugin
// (see preset-build.ts). Each plugin is its own chunk, loaded independently: many were written for Node, so a plugin
// that throws at load is SKIPPED (recorded in `pluginStatus()`) and its rules simply don't run — the rest of the
// preset still applies. A workspace `eslint.config.*` layers ON TOP of the preset (`[...preset, ...workspace]`).
//
// Every rule is also GUARDED: one that throws while linting (needs type information, touches a missing filesystem)
// disables itself for that file instead of aborting the whole `verify`.

type RuleModule = { "create": (context: unknown) => Record<string, unknown> | undefined } & Record<string, unknown>;

const brokenRuleErrors = new Map<string, string>();

function noteBroken(id: string, error: unknown): void {
	if (!brokenRuleErrors.has(id)) {
		brokenRuleErrors.set(id, error instanceof Error ? error.message : String(error));
	}
}

function guardRule(id: string, rule: RuleModule): RuleModule {
	return {
		...rule,
		"create": function(context: unknown) {
			let listeners: Record<string, unknown> | undefined;

			try {
				listeners = rule.create(context);
			} catch (error) {
				noteBroken(id, error);

				return {};
			}

			const safe: Record<string, unknown> = {};

			for (const [selector, handler] of Object.entries(listeners ?? {})) {
				safe[selector] = typeof handler === "function"
					? function(this: unknown, ...args: unknown[]) {
						try {
							return (handler as (...values: unknown[]) => unknown).apply(this, args);
						} catch (error) {
							noteBroken(id, error);

							return undefined;
						}
					}
					: handler;
			}

			return safe;
		}
	};
}

const plugins: Record<string, { "rules": Record<string, RuleModule> }> = {};
const failedPlugins: Record<string, string> = {};
const pluginLoadMs: Record<string, number> = {};

// Plugins that pass `require` around as a VALUE (e.g. es-x's `optionalRequire(require, "typescript")`) are rewritten at
// build time to use this instead of the bundler's runtime `require`, which throws in a worker. It serves the few
// modules the engine can hand out — `typescript` is tsserver's own instance — and MODULE_NOT_FOUND otherwise.
(globalThis as { "__eslintRequire"?: unknown }).__eslintRequire = createRequire("/lsp/eslint-engine.js");

// Load every plugin concurrently; keep the survivors. Top-level await: the plugin imports this engine as native ESM,
// so its import resolves once the preset is ready.
await Promise.all(Object.entries(presetPlugins as Record<string, () => Promise<{ "rules": Record<string, RuleModule | undefined> }>>).map(async ([name, load]) => {
	const started = performance.now();

	try {
		const plugin = await load();
		const rules: Record<string, RuleModule> = {};

		for (const [rule, module] of Object.entries(plugin.rules)) {
			if (module !== undefined && typeof module.create === "function") {
				rules[rule] = guardRule(`${name}/${rule}`, module);
			}
		}

		plugins[name] = { "rules": rules };
	} catch (error) {
		const frame = error instanceof Error ? error.stack?.split("\n").find((line) => line.includes(" at ")) : undefined;

		failedPlugins[name] = (error instanceof Error ? error.message : String(error)) + (frame === undefined ? "" : ` (${frame.trim()})`);
	}

	pluginLoadMs[name] = Math.round(performance.now() - started);
}));

/** Which preset plugins loaded (with their rule counts and load times) and which were skipped (with the error). */
export function pluginStatus(): { "loaded": Record<string, number>; "failed": Record<string, string>; "loadMs": Record<string, number>; "brokenRules": Record<string, string> } {
	return {
		"loaded": Object.fromEntries(Object.entries(plugins).map(([name, plugin]) => [name, Object.keys(plugin.rules).length])),
		"failed": { ...failedPlugins },
		"loadMs": { ...pluginLoadMs },
		"brokenRules": Object.fromEntries(brokenRuleErrors)
	};
}

/** The plugin prefix of a rule id (`style/indent` → `style`, `@scope/plugin/rule` → `@scope/plugin`), or undefined for core. */
function pluginOf(id: string): string | undefined {
	if (!id.includes("/")) {
		return undefined;
	}

	return id.startsWith("@") ? id.slice(0, id.indexOf("/", id.indexOf("/") + 1)) : id.slice(0, id.indexOf("/"));
}

// Whether the bundled Linter can run a rule. Config rules are filtered against this so an unknown rule, or one whose
// plugin was skipped, can't abort `verify` (flat config throws when a rule/plugin is missing). Plugin rules: present in
// a loaded plugin. Core rules: the `universal` Linter has no `getRules()`, so probe — a trivial `verify` throws for an
// unknown rule and returns for a known one. Cached.
const knownRuleCache = new Map<string, boolean>();

function isKnownRule(id: string): boolean {
	const plugin = pluginOf(id);

	if (plugin !== undefined) {
		return plugins[plugin]?.rules[id.slice(plugin.length + 1)] !== undefined;
	}

	const cached = knownRuleCache.get(id);

	if (cached !== undefined) {
		return cached;
	}

	let known: boolean;

	try {
		linter.verify("x;", [{ "rules": { [id]: "error" } }], { "filename": "probe.js" });
		known = true;
	} catch {
		known = false;
	}

	knownRuleCache.set(id, known);

	return known;
}

/** Parser options that need a real filesystem / project on disk — meaningless here. */
const FS_PARSER_OPTIONS = new Set(["project", "projectService", "tsconfigRootDir", "programs", "extraFileExtensions"]);

// Normalize a flat config given as DATA (the build-time preset, or a workspace config evaluated in the sandbox, whose
// functions — parsers, plugins — were stripped) into blocks the bundled Linter can run. Plugins are dropped (the loaded
// ones are registered once, globally); any parser becomes the bundled @typescript-eslint/parser; rules the engine can't
// run are dropped. Blocks with no rules survive when they carry ignores, files-scoped options, etc.
function normalizeConfig(raw: unknown): Linter.Config[] {
	const blocks = Array.isArray(raw) ? raw : [raw];
	const out: Linter.Config[] = [];

	for (const block of blocks as Record<string, unknown>[]) {
		if (block === null || typeof block !== "object") {
			continue;
		}

		const config: Record<string, unknown> = {};

		for (const key of ["name", "files", "ignores", "settings", "linterOptions"]) {
			if (block[key] !== undefined) {
				config[key] = block[key];
			}
		}

		const source = block["languageOptions"] as Record<string, unknown> | undefined;

		if (source !== undefined && source !== null && typeof source === "object") {
			const languageOptions: Record<string, unknown> = {};

			if (source["parser"] !== undefined) {
				languageOptions["parser"] = tsParser;
			}

			for (const key of ["ecmaVersion", "sourceType", "globals"]) {
				if (source[key] !== undefined) {
					languageOptions[key] = source[key];
				}
			}

			const parserOptions = source["parserOptions"];

			if (parserOptions !== null && typeof parserOptions === "object") {
				languageOptions["parserOptions"] = Object.fromEntries(Object.entries(parserOptions as Record<string, unknown>).filter(([name]) => !FS_PARSER_OPTIONS.has(name)));
			}

			config["languageOptions"] = languageOptions;
		}

		if (block["rules"] !== null && typeof block["rules"] === "object") {
			config["rules"] = Object.fromEntries(Object.entries(block["rules"] as Record<string, unknown>).filter(([id]) => isKnownRule(id)));
		}

		if (Object.keys(config).some((key) => key !== "name")) {
			out.push(config as Linter.Config);
		}
	}

	return out;
}

const preset = presetData as { "source": string; "blocks": unknown[] };
const presetBlocks = normalizeConfig(preset.blocks);
const baseConfig: Linter.Config[] = presetBlocks.length > 0 ? [{ "plugins": plugins as unknown as Linter.Config["plugins"] }, ...presetBlocks] : fallbackConfig;

// The active config: the preset base, plus the workspace `eslint.config.*` layered on top once applied. Keyed by the
// config's source text so the (relatively expensive) transpile + evaluate only re-runs when the file changes.
let activeConfig: Linter.Config[] = baseConfig;
let activeSource: string | undefined;

/** Apply the workspace `eslint.config.*`: transpile it, evaluate it in the capability-gated realm (no network/IO,
 *  returns data only), normalize it, and layer it on top of the preset base. The base alone when `text` is empty or
 *  evaluation fails. A no-op when `text` is unchanged. Async — the realm eval is off-thread; `activeConfig` swaps in
 *  when it resolves, so `lintText` stays synchronous and uses the previous config until then. */
export async function applyWorkspaceConfig(text: string | undefined): Promise<void> {
	if (text === activeSource) {
		return;
	}

	activeSource = text;

	if (text === undefined || text === "") {
		activeConfig = baseConfig;

		return;
	}

	const ts = (globalThis as { "__eslintTs"?: typeof import("typescript") }).__eslintTs;
	const code = ts === undefined
		? text
		: ts.transpileModule(text, { "compilerOptions": { "module": ts.ModuleKind.CommonJS, "target": ts.ScriptTarget.ES2020 } }).outputText;

	// A config that spreads the preset (`import config from "@brianjenkins94/util/eslint"`) gets the same preset data the
	// base is built from; every other import is an inert stub.
	const result = await gatedEvalRealm(code, { [preset.source]: preset.blocks });

	// The config's source is untrusted; a capability attempt is an alarm, not a grant (well-behaved configs use none).
	if (result.attempts.length > 0) {
		console.warn("[eslint-engine] workspace eslint config attempted capabilities in the sandbox (denied):", result.attempts);
	}

	if (text !== activeSource) {
		return; // the config changed again while we were evaluating; a later call owns the result
	}

	if (result.error !== undefined) {
		console.error("[eslint-engine] workspace config evaluation failed, using the preset alone:", result.error);
		activeConfig = baseConfig;

		return;
	}

	activeConfig = [...baseConfig, ...normalizeConfig(result.value)];
}

/** Lint one document's text; returns [] on any failure so a bad file never breaks the checker pass. Messages
 *  are ordered errors-first (severity 2 before 1); the sort is stable, so source order is kept within a severity. */
export function lintText(text: string, filename: string): LintMessage[] {
	try {
		const messages = linter.verify(text, activeConfig, { "filename": filename }).map((message) => ({ ...message, "fixable": message.fix !== undefined }));

		return messages.sort((a, b) => b.severity - a.severity);
	} catch (error) {
		// A config/rule error aborts the whole run — say so on the file instead of silently reporting nothing.
		return [{ "line": 1, "column": 1, "message": "ESLint couldn't lint this file: " + (error instanceof Error ? error.message : String(error)), "severity": 1, "ruleId": null, "fixable": false }];
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
