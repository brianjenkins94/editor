/**
 * ESLint TypeScript Server Plugin — runs INSIDE the in-browser tsserver, so it has the REAL `ts` and reuses it
 * instead of bundling a copy (the engine's ts-external shim reads the `globalThis.__eslintTs` we set below).
 * This replaces the almostnode-hosted eslint LSP server: the linter runs where tsserver already loaded `ts`.
 *
 * How it's loaded: registered as extension files (registerFileUrl) whose extension-file:// probe URIs the
 * ext-host worker's patched fetch/importExt (monaco vscode-patch 0005) resolves to the data: URLs. The served
 * engine URL (the eslint + parser bundle, typescript-external) arrives via plugin config (extension →
 * `_typescript.configurePlugin`), and is loaded here by a native dynamic import.
 *
 * Diagnostics: on `getSemanticDiagnostics` it lints the file's current text and pushes NATIVE `ts.Diagnostic`s
 * (source "eslint") onto the result — real editor squiggles + Problems-panel entries, no extension-side
 * decoding. eslint positions are 1-based line/column; we convert to absolute offsets via the SourceFile.
 * The extension (the web `dbaeumer.vscode-eslint`) pushes `eslint.enable` / `validate` / `rules.customizations`
 * via configurePlugin, applied here with the desktop server's semantics.
 *
 * Fixes: the `_eslint.fixAll` protocol request returns the text with every autofix applied — the backend for the
 * extension's `source.fixAll.eslint` code action and its formatter.
 */

export default function init(modules) {
	const ts = modules.typescript;

	// Hand the (typescript-external) engine tsserver's own `ts` — its shim reads this at load.
	try {
		globalThis.__eslintTs = ts;
	} catch (error) { /* non-fatal */ }

	// Bundler-proof native dynamic import of the served (http) engine URL from inside the tsserver worker.
	// eslint-disable-next-line no-new-func
	const importUrl = new Function("u", "return import(u);");

	let engineUrl;
	let engine;
	let engineError;

	function loadEngine() {
		if (engineUrl === undefined || engine !== undefined || engineError !== undefined) {
			return;
		}

		importUrl(engineUrl).then(function(module) {
			engine = module;
		}).catch(function(error) {
			engineError = String((error && error.message) || error);
		});
	}

	// The `eslint.*` settings the extension pushes via configurePlugin (the web twin of dbaeumer.vscode-eslint's).
	let settings = { "enable": true, "validate": null, "rulesCustomizations": [] };

	function applyConfig(config) {
		if (config && typeof config.engineUrl === "string" && config.engineUrl !== "") {
			engineUrl = config.engineUrl;
			loadEngine();
		}

		if (config && config.settings && typeof config.settings === "object") {
			settings = { ...settings, ...config.settings };
		}
	}

	// File extension → the VS Code language id `eslint.validate` lists (tsserver only ever hands us JS/TS).
	function languageOf(fileName) {
		const match = /\.([cm]?[jt]sx?)$/u.exec(fileName);
		const ext = match === null ? "" : match[1].replace(/^[cm]/u, "");

		return { "js": "javascript", "jsx": "javascriptreact", "ts": "typescript", "tsx": "typescriptreact" }[ext];
	}

	// Whether eslint should run on this file at all: `eslint.enable`, then `eslint.validate` (null = the default
	// probe list, which covers every JS/TS language).
	function validates(fileName) {
		if (settings.enable === false) {
			return false;
		}

		return !Array.isArray(settings.validate) || settings.validate.includes(languageOf(fileName));
	}

	// `eslint.rules.customizations`, with the desktop server's semantics: `*` globs, a leading `!` negates, an entry
	// with `fixable` only applies when it matches whether the problem has a fix, and the LAST match wins.
	function patternMatches(pattern, ruleId) {
		const negate = pattern.startsWith("!");
		const regex = new RegExp("^" + (negate ? pattern.slice(1) : pattern).replace(/\*/gu, ".*") + "$", "u");

		return negate ? !regex.test(ruleId) : regex.test(ruleId);
	}

	function overrideFor(ruleId, fixable) {
		let severity;

		for (const entry of Array.isArray(settings.rulesCustomizations) ? settings.rulesCustomizations : []) {
			if (entry && typeof entry.rule === "string" && patternMatches(entry.rule, ruleId) && (entry.fixable === undefined || entry.fixable === fixable)) {
				severity = entry.severity;
			}
		}

		return severity;
	}

	// eslint severity (1 warn / 2 error) + an override → a ts.DiagnosticCategory, or undefined for "off".
	function categoryOf(eslintSeverity, override) {
		const base = eslintSeverity === 2 ? "error" : "warn";
		const resolved = override === "downgrade" ? (base === "error" ? "warn" : "info")
			: override === "upgrade" ? "error"
				: override === "off" || override === "info" || override === "warn" || override === "error" ? override
					: base;

		if (resolved === "off") {
			return undefined;
		}

		// "info" can't be expressed through tsserver: the TS extension maps only error/warning/suggestion and turns
		// anything else (a Message) into an Error, while Suggestion becomes a Hint that leaves the Problems panel. So
		// info surfaces as a Warning — the nearest severity that stays visible.
		return resolved === "error" ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning;
	}

	// The desktop server tags unused-variable problems as "unnecessary" (rendered faded).
	const UNUSED_RULES = new Set(["no-unused-imports", "no-unused-private-class-members", "no-unused-vars"]);

	function isUnnecessary(message) {
		const ruleId = typeof message.ruleId === "string" ? message.ruleId.slice(message.ruleId.lastIndexOf("/") + 1) : "";

		return UNUSED_RULES.has(ruleId) || /\b(?:defined|assigned)\b.+\bnever used\b/iu.test(message.message);
	}

	// `_eslint.fixAll` — the extension's fix-all-on-save and formatter call this through `typescript.tsserverRequest`
	// (which only forwards custom commands that start with "_"). The request carries the document TEXT, so unsaved
	// edits are fixed as they are. Registered once per tsserver, from the first project that has a session.
	let fixAllRegistered = false;

	function registerFixAll(session) {
		if (fixAllRegistered || session === undefined || typeof session.addProtocolHandler !== "function") {
			return;
		}

		fixAllRegistered = true;
		session.addProtocolHandler("_eslint.fixAll", function(request) {
			const args = (request && request.arguments) || {};
			const text = typeof args.text === "string" ? args.text : "";
			const file = typeof args.file === "string" ? args.file : "";
			const result = engine === undefined || typeof engine.fixText !== "function" || !validates(file)
				? { "output": text, "fixed": false }
				: engine.fixText(text, file);

			return { "response": result, "responseRequired": true };
		});
	}

	// This plugin is served as a real file next to the engine (/__vscode__/lsp/eslint-ts-plugin.js and
	// eslint-engine.js), so resolve the engine RELATIVE to this module's own URL — deploy-base-agnostic, with no
	// runtime-baked URL and no config dependency. `import.meta.url` is the plugin's served URL because tsserver
	// imports it from there. `_typescript.configurePlugin({ engineUrl })` still overrides (see applyConfig).
	try {
		engineUrl = new URL("./eslint-engine.js", import.meta.url).href;
		loadEngine();
	} catch (error) { /* fall back to configurePlugin */ }

	/** eslint 1-based (line, column) → absolute offset in the source file; clamped so an out-of-range
	 *  position can't throw and abort the whole diagnostics pass. */
	function offsetOf(sourceFile, line, column) {
		try {
			return sourceFile.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, column - 1));
		} catch (error) {
			return 0;
		}
	}

	return {
		"create": function(info) {
			applyConfig(info.config);
			registerFixAll(info.session);

			const ls = info.languageService;
			const host = info.languageServiceHost;
			const project = info.project;

			// The workspace's own flat config, read through tsserver's host (so it sees the in-browser workspace FS).
			// Checked at the workspace root; the engine caches by text, so re-reading each diagnostics pass is cheap.
			const configNames = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"];

			function readWorkspaceConfig() {
				try {
					const dir = (project && project.getCurrentDirectory && project.getCurrentDirectory()) || "/workspace";
					const base = dir.replace(/\/+$/, "");

					for (const name of configNames) {
						const path = base + "/" + name;

						if (host && host.fileExists && host.fileExists(path) && host.readFile) {
							const text = host.readFile(path);

							if (typeof text === "string") {
								return text;
							}
						}
					}
				} catch (error) { /* fall back to the engine's built-in config */ }

				return undefined;
			}

			const proxy = Object.create(null);

			for (const key of Object.keys(ls)) {
				proxy[key] = function(...args) {
					return ls[key](...args);
				};
			}

			proxy.getSemanticDiagnostics = function(fileName) {
				const prior = ls.getSemanticDiagnostics(fileName);

				if (engine === undefined) {
					// Not loaded yet (or failed) — return tsserver's own diagnostics unchanged.
					return prior;
				}

				const program = ls.getProgram();
				const sourceFile = program === undefined ? undefined : program.getSourceFile(fileName);

				if (sourceFile === undefined || !validates(fileName)) {
					return prior;
				}

				try {
					if (typeof engine.applyWorkspaceConfig === "function") {
						// Fire-and-forget: the config is evaluated off-thread in a sandbox; the engine swaps its active
						// config in when that resolves, so this lint pass uses whatever is current.
						Promise.resolve(engine.applyWorkspaceConfig(readWorkspaceConfig())).catch(function() { /* never breaks linting */ });
					}

					const messages = engine.lintText(sourceFile.text, fileName);

					for (const message of messages) {
						const category = categoryOf(message.severity, message.ruleId === null ? undefined : overrideFor(message.ruleId, message.fixable === true));

						if (category === undefined) {
							continue; // customized "off": hidden, but still fixed by fix-all
						}

						const start = offsetOf(sourceFile, message.line, message.column);
						const end = message.endLine !== undefined && message.endColumn !== undefined
							? offsetOf(sourceFile, message.endLine, message.endColumn)
							: start + 1;

						prior.push({
							"file": sourceFile,
							"start": start,
							"length": Math.max(0, end - start),
							"code": 0,
							"category": category,
							"source": "eslint",
							"reportsUnnecessary": isUnnecessary(message) ? true : undefined,
							"messageText": message.ruleId === null ? message.message : message.message + " (" + message.ruleId + ")"
						});
					}
				} catch (error) { /* a lint failure never takes tsserver's own diagnostics down */ }

				return prior;
			};

			return proxy;
		},
		"onConfigurationChanged": function(config) { applyConfig(config); }
	};
}
