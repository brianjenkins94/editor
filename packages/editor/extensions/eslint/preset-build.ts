/**
 * Build-time extraction of the user's shared ESLint preset (`@brianjenkins94/util/eslint`) for the in-browser engine.
 *
 * The preset is antfu's config refilled with the `all` catalogs and a severity pass — generated LIVE in Node (top-level
 * await, antfu's filesystem-probing package detection), so it can't run in the browser. The engine build evaluates it
 * here and emits two virtual modules:
 *
 *   • `eslint:preset` — the flat-config blocks as pure DATA, keeping only blocks that can apply to JS/TS (the engine
 *     only sees files through tsserver). A block's parser becomes the marker "typescript" (the engine supplies its
 *     bundled @typescript-eslint/parser); filesystem-bound parser options are dropped; `plugins` are stripped (the
 *     engine registers them once, globally).
 *   • `eslint:preset-plugins` — one LOADER per plugin (`name → () => import(...)`), each resolving to `{ rules }` with
 *     exactly the rules the blocks enable. Every loader is its own dynamic import, so each plugin lands in its own
 *     chunk and loads independently: a plugin that can't run in the browser fails ALONE (the engine skips it) instead
 *     of taking the whole engine down. Rules are located by object IDENTITY against antfu's installed plugin packages
 *     (antfu composes some plugin objects, e.g. `test` = vitest + no-only-tests), falling back to a match by rule name
 *     within the package that owns the plugin's other rules (a package antfu loaded as a separate module instance).
 *
 * Nothing about the preset is hand-copied: bump @brianjenkins94/util and the next build re-derives it.
 */
import type { Plugin } from "vite";
import { createRequire } from "node:module";
import * as path from "node:path";
import { log } from "@brianjenkins94/util/logger";

const PRESET = "@brianjenkins94/util/eslint";
const DATA_VIRTUAL = "eslint:preset";
const PLUGINS_VIRTUAL = "eslint:preset-plugins";

/** Representative paths — a block is kept when its `files` could match any of them. */
const PROBE_PATHS = ["src/a.ts", "src/a.tsx", "src/a.js", "src/a.jsx", "src/a.mjs", "src/a.cjs", "src/a.mts", "src/a.cts", "src/a.d.ts", "scripts/a.ts", "cli.ts", "bin/a.js", "a.config.ts", "src/a.test.ts", "src/__tests__/a.ts"];

/** Parser options that only make sense with a real filesystem / project on disk. */
const FS_PARSER_OPTIONS = new Set(["project", "projectService", "tsconfigRootDir", "programs", "extraFileExtensions"]);

type Block = Record<string, unknown> & { "files"?: unknown[]; "rules"?: Record<string, unknown>; "plugins"?: Record<string, { "rules"?: Record<string, unknown> }> };

interface Extracted {
	"blocks": Record<string, unknown>[];
	/** plugin name → rule name → [package entry resolved to an absolute path, rule key in that package]. */
	"sources": Map<string, Map<string, [string, string]>>;
	"version": string;
}

/** Whether a value survives a JSON round trip unchanged (rule options must — they're serialized into the bundle). */
function isJsonSafe(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.every(isJsonSafe);
	}

	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.values(value as Record<string, unknown>).every(isJsonSafe);
	}

	return false;
}

/** The plugin prefix of a rule id (`style/indent` → `style`, `@scope/plugin/rule` → `@scope/plugin`), or undefined for core. */
function pluginOf(id: string): string | undefined {
	if (!id.includes("/")) {
		return undefined;
	}

	return id.startsWith("@") ? id.slice(0, id.indexOf("/", id.indexOf("/") + 1)) : id.slice(0, id.indexOf("/"));
}

async function extract(): Promise<Extracted> {
	const localRequire = createRequire(import.meta.url);
	const presetEntry = localRequire.resolve(PRESET);
	const antfuPackageJson = createRequire(presetEntry).resolve("@antfu/eslint-config/package.json");
	const antfuRequire = createRequire(antfuPackageJson);
	const antfuManifest = localRequire(antfuPackageJson) as { "dependencies"?: Record<string, string> };
	const utilManifest = localRequire(path.join(path.dirname(presetEntry), "package.json")) as { "version"?: string };
	const { minimatch } = await import(createRequire(localRequire.resolve("eslint")).resolve("minimatch")) as { "minimatch": (file: string, pattern: string, options: { "dot": boolean }) => boolean };
	const configs = (await import(presetEntry) as { "default": Block[] }).default;

	// Every plugin object antfu registered (the same object shows up in several setup blocks).
	const registered: Record<string, { "rules"?: Record<string, unknown> }> = {};

	for (const block of configs) {
		Object.assign(registered, block.plugins ?? {});
	}

	// Rule object → [package entry, rule key], across antfu's plugin dependencies.
	const owners = new Map<unknown, [string, string]>();
	const packageRules = new Map<string, Record<string, unknown>>();

	for (const name of Object.keys(antfuManifest.dependencies ?? {})) {
		let resolved: string;
		let module: Record<string, unknown>;

		try {
			resolved = antfuRequire.resolve(name);
			module = await import(resolved) as Record<string, unknown>;
		} catch {
			continue; // not a runtime package (types, a CLI) or not importable here
		}

		for (const candidate of [module["default"], module, (module["default"] as Record<string, unknown> | undefined)?.["default"]]) {
			const rules = (candidate as { "rules"?: Record<string, unknown> } | undefined)?.rules;

			if (rules !== undefined && typeof rules === "object") {
				packageRules.set(resolved, rules);

				for (const [key, rule] of Object.entries(rules)) {
					if (!owners.has(rule)) {
						owners.set(rule, [resolved, key]);
					}
				}
			}
		}
	}

	const applies = (block: Block): boolean => block.files === undefined || block.files.flat().some((pattern) => typeof pattern === "string" && PROBE_PATHS.some((file) => minimatch(file, pattern, { "dot": true })));
	const sources = new Map<string, Map<string, [string, string]>>();

	// Where a plugin rule is implemented; undefined when it can't be located (the rule is then dropped).
	const locate = (plugin: string, rule: string): [string, string] | undefined => {
		const object = registered[plugin]?.rules?.[rule];

		if (object === undefined) {
			return undefined;
		}

		const byIdentity = owners.get(object);

		if (byIdentity !== undefined) {
			return byIdentity;
		}

		// Same package, separate module instance: prefer a package that already provides this plugin's rules.
		const known = new Set([...(sources.get(plugin)?.values() ?? [])].map(([pkg]) => pkg));
		const candidates = [...packageRules].filter(([, rules]) => rule in rules).sort(([a], [b]) => Number(known.has(b)) - Number(known.has(a)));

		return candidates.length > 0 ? [candidates[0][0], rule] : undefined;
	};

	const blocks: Record<string, unknown>[] = [];
	const dropped: string[] = [];

	for (const block of configs) {
		if (block["name"] === "antfu/gitignore" || !applies(block)) {
			continue; // the gitignore block carries THIS repo's .gitignore; non-JS/TS blocks can't apply in-browser
		}

		const out: Record<string, unknown> = {};

		for (const key of ["name", "files", "ignores", "settings", "linterOptions"]) {
			if (block[key] !== undefined && isJsonSafe(block[key])) {
				out[key] = block[key];
			}
		}

		const languageOptions = block["languageOptions"] as Record<string, unknown> | undefined;

		if (languageOptions !== undefined) {
			const options: Record<string, unknown> = {};

			for (const [key, value] of Object.entries(languageOptions)) {
				if (key === "parser") {
					options["parser"] = "typescript"; // marker: the engine supplies its bundled @typescript-eslint/parser
				} else if (key === "parserOptions" && value !== null && typeof value === "object") {
					options["parserOptions"] = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([name, option]) => !FS_PARSER_OPTIONS.has(name) && isJsonSafe(option)));
				} else if (isJsonSafe(value)) {
					options[key] = value;
				}
			}

			out["languageOptions"] = options;
		}

		if (block.rules !== undefined) {
			const rules: Record<string, unknown> = {};

			for (const [id, setting] of Object.entries(block.rules)) {
				const plugin = pluginOf(id);
				const source = plugin === undefined ? undefined : locate(plugin, id.slice(plugin.length + 1));

				if (!isJsonSafe(setting) || (plugin !== undefined && source === undefined)) {
					dropped.push(id);
				} else {
					rules[id] = setting;

					if (plugin !== undefined && source !== undefined) {
						if (!sources.has(plugin)) {
							sources.set(plugin, new Map());
						}

						sources.get(plugin)?.set(id.slice(plugin.length + 1), source);
					}
				}
			}

			out["rules"] = rules;
		}

		if (Object.keys(out).some((key) => key !== "name")) {
			blocks.push(out);
		}
	}

	if (dropped.length > 0) {
		log.warn(`[eslint:preset] dropped ${dropped.length} rule setting(s) that can't be carried to the browser: ${[...new Set(dropped)].join(", ")}`);
	}

	const ruleCount = [...sources.values()].reduce((total, rules) => total + rules.size, 0);

	log.info(`[eslint:preset] ${PRESET}@${utilManifest.version ?? "?"}: ${blocks.length} of ${configs.length} blocks, ${sources.size} plugins, ${ruleCount} plugin rules`);

	return { "blocks": blocks, "sources": sources, "version": utilManifest.version ?? "" };
}

/** The `eslint:preset` + `eslint:preset-plugins` virtual modules (see the header). Evaluated once per build. */
export function eslintPresetPlugin(): Plugin {
	let extracted: Promise<Extracted> | undefined;
	const data = "\0" + DATA_VIRTUAL;
	const plugins = "\0" + PLUGINS_VIRTUAL;

	return {
		"name": "eslint-preset",
		"resolveId": (id) => (id === DATA_VIRTUAL ? data : id === PLUGINS_VIRTUAL ? plugins : undefined),
		"load": async (id) => {
			if (id !== data && id !== plugins) {
				return undefined;
			}

			const result = await (extracted ??= extract());

			if (id === data) {
				return `export default ${JSON.stringify({ "source": PRESET, "version": result.version, "blocks": result.blocks })};`;
			}

			// One loader per plugin: its own dynamic import(s) → its own chunk(s), loaded (and failing) independently.
			const loaders = [...result.sources].map(([plugin, rules]) => {
				const packages = [...new Set([...rules.values()].map(([pkg]) => pkg))];
				const imports = packages.map((pkg) => `import(${JSON.stringify(pkg)})`).join(", ");
				const ruleEntries = [...rules].map(([rule, [pkg, key]]) => `${JSON.stringify(rule)}: rulesOf(modules[${packages.indexOf(pkg)}])[${JSON.stringify(key)}]`).join(", ");

				return `${JSON.stringify(plugin)}: async () => { const modules = await Promise.all([${imports}]); return { "rules": { ${ruleEntries} } }; }`;
			}).join(",\n\t");

			return `function rulesOf(module) { for (const candidate of [module.default, module, module.default && module.default.default]) { if (candidate && candidate.rules) return candidate.rules; } return {}; }\nexport default {\n\t${loaders}\n};\n`;
		}
	};
}
