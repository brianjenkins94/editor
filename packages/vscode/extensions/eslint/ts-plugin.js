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

	// The engine URL is BAKED in at registration time: workbench-entry replaces this sentinel with the served
	// /__vscode__/lsp/eslint-engine.js URL (it has location.href; the plugin, inside tsserver, does not). This
	// avoids depending on a runtime config setting reaching the plugin (which the workbench's persisted config
	// can shadow). `_typescript.configurePlugin` still works as an override (see applyConfig).
	const BAKED_ENGINE_URL = "__ESLINT_ENGINE_URL__";

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

	function applyConfig(config) {
		if (config && typeof config.engineUrl === "string" && config.engineUrl !== "") {
			engineUrl = config.engineUrl;
			loadEngine();
		}
	}

	// If the sentinel was replaced with a real URL, load the engine straight away (no configurePlugin needed).
	if ((/^https?:/u).test(BAKED_ENGINE_URL)) {
		engineUrl = BAKED_ENGINE_URL;
		loadEngine();
	}

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

			const ls = info.languageService;
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

				if (sourceFile === undefined) {
					return prior;
				}

				try {
					const messages = engine.lintText(sourceFile.text, fileName);

					for (const message of messages) {
						const start = offsetOf(sourceFile, message.line, message.column);
						const end = message.endLine !== undefined && message.endColumn !== undefined
							? offsetOf(sourceFile, message.endLine, message.endColumn)
							: start + 1;

						prior.push({
							"file": sourceFile,
							"start": start,
							"length": Math.max(0, end - start),
							"code": 0,
							"category": message.severity === 2 ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
							"source": "eslint",
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
