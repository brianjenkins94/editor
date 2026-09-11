/**
 * Preflight TypeScript Server Plugin — the SOLE analysis engine (route 3 B). It runs INSIDE the in-browser
 * tsserver, so it has the REAL `ts` + Program + TypeChecker over the user's ACTUAL project, and — being in
 * tsserver — it reuses that `ts` instead of bundling a copy (the plugin engine's ts-external shim reads the
 * `globalThis.__preflightTs` we set below).
 *
 * How it's loaded: registered as extension files (registerFileUrl); the ext-host worker's patched
 * fetch/importExt resolves its extension-file:// URIs through the static browser-URI map (monaco vscode-patch
 * 0005) to the data: URLs. The served engine URL arrives via plugin config (extension →
 * `_typescript.configurePlugin`).
 *
 * Results channel: on `getSemanticDiagnostics` it runs `runPreflight` over the file (cached by text), enriches
 * each finding's `type` from the real checker (`getTypeAtLocation`, climbed to the call expression so
 * `fetch(...)` → `Promise<Response>`), and emits ONE `Suggestion` diagnostic whose message carries the rows as
 * `@@PFR@@<json>@@PFR@@`. Suggestion severity keeps it out of the Problems panel; the extension reads it with
 * `vscode.languages.getDiagnostics`. No hover proxy, so nothing leaks into user hovers.
 */

export default function init(modules) {
	const ts = modules.typescript;
	// Hand the (typescript-external) plugin engine tsserver's own `ts` — its shim reads this at load.
	try { globalThis.__preflightTs = ts; } catch (error) { /* non-fatal */ }
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

		importUrl(engineUrl).then(function(module) { engine = module; }).catch(function(error) {
			engineError = String((error && error.message) || error);
		});
	}

	function applyConfig(config) {
		if (config && typeof config.engineUrl === "string" && config.engineUrl !== "") {
			engineUrl = config.engineUrl;
			loadEngine();
		}
	}

	/** Smallest node at `pos`, climbed to the outermost node that STARTS there (so a finding anchored at
	 *  `fetch` yields the call-result type `Promise<Response>`, not the bare function type). */
	function typedNodeAt(sourceFile, pos) {
		let found;

		(function visit(node) {
			if (pos >= node.getStart(sourceFile) && pos < node.getEnd()) {
				found = node;
				node.forEachChild(visit);
			}
		})(sourceFile);

		while (found !== undefined && found.parent !== undefined && found.parent.getStart(sourceFile) === found.getStart(sourceFile) && found.parent.getEnd() >= found.getEnd()) {
			found = found.parent;
		}

		return found;
	}

	let cacheText;
	let cacheResult;

	return {
		"create": function(info) {
			applyConfig(info.config);

			const ls = info.languageService;
			const proxy = Object.create(null);

			for (const key of Object.keys(ls)) {
				proxy[key] = function(...args) { return ls[key].apply(ls, args); };
			}

			proxy.getSemanticDiagnostics = function(fileName) {
				const prior = ls.getSemanticDiagnostics(fileName);
				const program = ls.getProgram();
				const sourceFile = program === undefined ? undefined : program.getSourceFile(fileName);

				if (sourceFile === undefined) {
					return prior;
				}

				let payload;

				try {
					if (engineError !== undefined) {
						payload = { "error": engineError };
					} else if (engine === undefined) {
						payload = { "pending": true };
					} else {
						if (sourceFile.text !== cacheText) {
							const result = engine.runPreflight(sourceFile.text, fileName);
							const checker = program.getTypeChecker();

							for (const row of result.rows) {
								if (row.cst !== undefined) {
									try {
										const node = typedNodeAt(sourceFile, row.cst.start);

										if (node !== undefined) {
											row.type = checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType);
										}
									} catch (error) { /* leave row.type unset */ }
								}
							}

							cacheResult = result;
							cacheText = sourceFile.text;
						}

						payload = { "rows": cacheResult.rows, "floating": cacheResult.floating };
					}
				} catch (error) {
					payload = { "error": String((error && error.stack) || error).slice(0, 600) };
				}

				prior.push({
					"file": sourceFile,
					"start": 0,
					"length": 0,
					"code": 900100,
					"category": ts.DiagnosticCategory.Suggestion,
					"source": "preflight",
					"messageText": "@@PFR@@" + JSON.stringify(payload) + "@@PFR@@"
				});

				return prior;
			};

			return proxy;
		},
		"onConfigurationChanged": function(config) { applyConfig(config); }
	};
}
