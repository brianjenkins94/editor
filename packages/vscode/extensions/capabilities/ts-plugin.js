/**
 * Capabilities TypeScript Server Plugin — runs the static capability engine (util/silo, via engine.ts) INSIDE
 * the in-browser tsserver so it can anchor each finding to the real SourceFile and enrich its `type` from the
 * real TypeChecker, then publishes ONE NATIVE `ts.Diagnostic` per capability call — a Warning for a dangerous
 * capability (silo policy), a Suggestion otherwise — so calls show as ordinary squiggles + Problems entries +
 * hover, with the resolved value + type in the message. Same shape as extensions/eslint/ts-plugin.js.
 *
 * The engine is pure static analysis (oxc, no typescript), so — unlike eslint — this plugin does NOT hand the
 * engine tsserver's `ts`; it only USES `ts` itself, for the span→node type enrichment. The engine is served
 * next to this file and resolved relative to `import.meta.url`.
 */

export default function init(modules) {
	const ts = modules.typescript;

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

	function applyConfig(config) {
		if (config && typeof config.engineUrl === "string" && config.engineUrl !== "") {
			engineUrl = config.engineUrl;
			loadEngine();
		}
	}

	// Served next to the engine, so resolve it relative to this module's own URL (deploy-base-agnostic).
	try {
		engineUrl = new URL("./capabilities-engine.js", import.meta.url).href;
		loadEngine();
	} catch (error) { /* fall back to configurePlugin */ }

	/** Smallest node at `pos`, climbed to the outermost node that STARTS there (so a finding anchored at `fetch`
	 *  yields the call-result type `Promise<Response>`, not the bare function type). */
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

	/** Dangerous capabilities (silo policy) are Warnings; the rest are Suggestions (the faint hint underline). */
	function categoryOf(row) {
		return row.dangerous ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Suggestion;
	}

	/** The squiggle's hover/Problems text: capability, callee, resolved value (or a note it needs a run), type. */
	function messageOf(row) {
		const type = typeof row.type === "string" && row.type !== "" && row.type !== "any" ? " · " + row.type : "";
		const value = row.resolved ? " → " + row.value : " → (unresolved — needs a run)";

		return `${row.capability}: ${row.callee}${value}${type}`;
	}

	let cacheText;
	let cacheRows = [];

	return {
		"create": function(info) {
			applyConfig(info.config);

			const ls = info.languageService;
			const proxy = Object.create(null);

			for (const key of Object.keys(ls)) {
				proxy[key] = function(...args) {
					return ls[key].apply(ls, args);
				};
			}

			proxy.getSemanticDiagnostics = function(fileName) {
				const prior = ls.getSemanticDiagnostics(fileName);

				if (engine === undefined) {
					return prior; // engine not loaded yet (or failed) — tsserver's own diagnostics, unchanged
				}

				const program = ls.getProgram();
				const sourceFile = program === undefined ? undefined : program.getSourceFile(fileName);

				if (sourceFile === undefined) {
					return prior;
				}

				try {
					if (sourceFile.text !== cacheText) {
						const rows = engine.analyze(sourceFile.text, fileName);
						const checker = program.getTypeChecker();

						for (const row of rows) {
							try {
								const node = typedNodeAt(sourceFile, row.start);

								if (node !== undefined) {
									row.type = checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType);
								}
							} catch (error) { /* leave row.type unset */ }
						}

						cacheRows = rows;
						cacheText = sourceFile.text;
					}

					for (const row of cacheRows) {
						prior.push({
							"file": sourceFile,
							"start": row.start,
							"length": Math.max(0, row.end - row.start),
							"code": 900100,
							"category": categoryOf(row),
							"source": "capabilities",
							"messageText": messageOf(row)
						});
					}
				} catch (error) { /* capability analysis is best-effort — never break tsserver's own diagnostics */ }

				return prior;
			};

			return proxy;
		},
		"onConfigurationChanged": function(config) { applyConfig(config); }
	};
}
