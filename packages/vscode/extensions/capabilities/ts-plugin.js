/**
 * Capabilities TypeScript Server Plugin — runs BOTH halves of the capability analysis INSIDE the in-browser
 * tsserver and publishes NATIVE `ts.Diagnostic`s (source "capabilities") — real squiggles + Problems entries +
 * hover, and the sole clean data channel out of tsserver, which the "Capability calls" panel reads back.
 *
 * STATIC half (engine.ts, util/silo `findReach`, oxc): synchronous. Flags every capability call whose resource is
 * a static string literal, anchored to the real SourceFile and type-enriched from the real checker.
 *
 * DYNAMIC half (canary.ts, tsval): resolves the resources the static half can't (computed args). It runs the
 * module in the tsval interpreter — which needs `typescript`, so the canary engine is built with ts EXTERNAL and
 * we hand it tsserver's own `ts` via `globalThis.__capabilitiesTs` (same trick as eslint), reusing the compiler
 * already loaded here instead of bundling a ~7MB copy. Because tsval is async (top-level await) and
 * getSemanticDiagnostics is synchronous, the canary runs in the BACKGROUND: on a text change we kick a run
 * (bounded by a tsval step budget so untrusted code can't hang the server), cache its observations, and call
 * `project.refreshDiagnostics()` to make tsserver re-request — the next pass merges the runtime values in.
 *
 * And, since it holds the project's real checker: the `_types.at` request (through `typescript.tsserverRequest`) says
 * what TypeScript makes of each of a file's ranges — runtime evidence's declared types and the typed strategy's
 * (RUNTIME-EVIDENCE.md). And `_statements`: a file's top-level statements, each with a title (what it declares or
 * calls), the comment above it, and the types of what it declares — what the program's projection (PROJECTIONS.md)
 * makes its cards of.
 */

export default function init(modules) {
	const ts = modules.typescript;

	// Hand the (typescript-external) canary engine tsserver's own `ts` — its ts-external shim reads this at load.
	try {
		globalThis.__capabilitiesTs = ts;
	} catch (error) { /* non-fatal */ }

	// Bundler-proof native dynamic import of the served (http) engine URLs from inside the tsserver worker.
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

	let canaryUrl;
	let canaryEngine;
	let canaryError;

	function loadCanary() {
		if (canaryUrl === undefined || canaryEngine !== undefined || canaryError !== undefined) {
			return;
		}

		importUrl(canaryUrl).then(function(module) {
			canaryEngine = module;
		}).catch(function(error) {
			canaryError = String((error && error.message) || error);
		});
	}

	function applyConfig(config) {
		if (config && typeof config.engineUrl === "string" && config.engineUrl !== "") {
			engineUrl = config.engineUrl;
			loadEngine();
		}
	}

	// Both engines are served next to this plugin, so resolve them relative to this module's own URL.
	try {
		engineUrl = new URL("./capabilities-engine.js", import.meta.url).href;
		loadEngine();
		canaryUrl = new URL("./capabilities-canary.js", import.meta.url).href;
		loadCanary();
	} catch (error) { /* fall back to configurePlugin (static engine only) */ }

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
	function categoryOf(dangerous) {
		return dangerous ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Suggestion;
	}

	/** The static row's message, enriched with the canary's runtime value when static couldn't resolve it. */
	function messageOf(row, observation) {
		const type = typeof row.type === "string" && row.type !== "" && row.type !== "any" ? " · " + row.type : "";
		let value;

		if (row.resolved) {
			value = " → " + row.value;
		} else if (observation !== undefined && observation.observed) {
			value = " → " + observation.value + " (ran)";
		} else {
			value = " → (unresolved — needs a run)";
		}

		return `${row.capability}: ${row.callee}${value}${type}`;
	}

	/** A canary-only finding (a dynamic call the static half never emitted a row for). */
	function canaryMessage(observation) {
		const value = observation.observed ? " → " + observation.value + " (ran)" : " → (ran; no string resource)";

		return `${observation.capability}: ${observation.callee}${value}`;
	}

	let cacheText;
	let cacheRows = [];

	// Canary observations are async; cache per file (keyed by exact text) and never re-run while a run is in flight.
	const canaryCache = new Map();
	const canaryInFlight = new Set();

	function maybeRunCanary(fileName, text, info) {
		if (canaryEngine === undefined) {
			return;
		}

		const cached = canaryCache.get(fileName);

		if ((cached !== undefined && cached.text === text) || canaryInFlight.has(fileName)) {
			return; // already have observations for this exact text, or a run is under way
		}

		canaryInFlight.add(fileName);
		canaryEngine.runCanary(text, fileName).then(function(observations) {
			canaryCache.set(fileName, { "text": text, "observations": observations });
		}).catch(function() {
			canaryCache.set(fileName, { "text": text, "observations": [] }); // cache empty so a failing file doesn't loop
		}).then(function() {
			canaryInFlight.delete(fileName);
			// Nudge tsserver to re-request diagnostics; the next pass finds the cache fresh (no re-run → no loop).
			try {
				if (info.project !== undefined && typeof info.project.refreshDiagnostics === "function") {
					info.project.refreshDiagnostics();
				}
			} catch (error) { /* refresh is best-effort */ }
		});
	}

	/** The innermost node of `sourceFile` whose range is exactly [start, end) — or that only adds its statement's `;`,
	 *  which TypeScript counts and BABLR's spans don't. */
	function nodeAt(sourceFile, start, end) {
		let found;
		const text = sourceFile.text;

		function visit(node) {
			const nodeStart = node.getStart(sourceFile);
			const nodeEnd = node.getEnd();

			if (nodeStart > start || nodeEnd < end) {
				return;
			}

			if (nodeStart === start && (nodeEnd === end || (nodeEnd === end + 1 && text[end] === ";"))) {
				found = node; // deeper matches overwrite: the innermost wins
			}

			ts.forEachChild(node, visit);
		}

		ts.forEachChild(sourceFile, visit);

		return found;
	}

	/** The type of what a site observed: the base a `?.` tested, the left side of `??`, a parameter, the value a
	 *  `return` gave, a function's return type — otherwise the node's own type. */
	function observedType(checker, node) {
		if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken !== undefined) {
			return checker.getTypeAtLocation(node.expression);
		}

		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
			return checker.getTypeAtLocation(node.left);
		}

		if (ts.isParameter(node)) {
			return checker.getTypeAtLocation(node.name);
		}

		if (ts.isReturnStatement(node)) {
			return node.expression === undefined ? checker.getVoidType() : checker.getTypeAtLocation(node.expression);
		}

		if (ts.isFunctionLike(node)) {
			const signature = checker.getSignatureFromDeclaration(node);

			if (signature !== undefined) {
				return checker.getReturnTypeOfSignature(signature);
			}
		}

		return checker.getTypeAtLocation(node);
	}

	// `_types.at` — each of a file's ranges as TypeScript types it (null where no node has the range). Registered once
	// per tsserver, from the first project that has a session; each request finds its file's own project.
	let typesRegistered = false;

	function registerTypesAt(info) {
		if (typesRegistered || info.session === undefined || typeof info.session.addProtocolHandler !== "function") {
			return;
		}

		typesRegistered = true;
		info.session.addProtocolHandler("_types.at", function(request) {
			const args = (request && request.arguments) || {};
			const file = typeof args.file === "string" ? args.file : "";
			const ranges = Array.isArray(args.ranges) ? args.ranges : [];
			const path = ts.server !== undefined && typeof ts.server.toNormalizedPath === "function" ? ts.server.toNormalizedPath(file) : file;
			const project = info.project.projectService.getDefaultProjectForFile(path, false) || info.project;
			const program = project.getLanguageService().getProgram();
			const sourceFile = program === undefined ? undefined : program.getSourceFile(path);
			const types = ranges.map(function(range) {
				try {
					const node = sourceFile === undefined ? undefined : nodeAt(sourceFile, range.start, range.end);

					return node === undefined ? null : program.getTypeChecker().typeToString(observedType(program.getTypeChecker(), node), node, ts.TypeFormatFlags.NoTruncation);
				} catch (error) {
					return null;
				}
			});

			return { "response": { "types": types }, "responseRequired": true };
		});

		// `_statements` — a file's top-level statements, as a projection's cards (PROJECTIONS.md): each one's range, kind,
		// title and detail (what it declares or calls), and the types of what it declares.
		info.session.addProtocolHandler("_statements", function(request) {
			const args = (request && request.arguments) || {};
			const file = typeof args.file === "string" ? args.file : "";
			const path = ts.server !== undefined && typeof ts.server.toNormalizedPath === "function" ? ts.server.toNormalizedPath(file) : file;
			const project = info.project.projectService.getDefaultProjectForFile(path, false) || info.project;
			const program = project.getLanguageService().getProgram();
			const sourceFile = program === undefined ? undefined : program.getSourceFile(path);

			if (sourceFile === undefined) {
				return { "response": { "statements": null }, "responseRequired": true };
			}

			const checker = program.getTypeChecker();

			function typeOf(node) {
				try {
					return checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation);
				} catch (error) {
					return null;
				}
			}

			return { "response": { "statements": sourceFile.statements.map(function(statement) {
				// The `//` comment right above it, if any — a step's own title.
				const comments = ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) || [];
				const comment = comments.filter(function(range) { return range.kind === ts.SyntaxKind.SingleLineCommentTrivia; }).map(function(range) { return sourceFile.text.slice(range.pos + 2, range.end).trim(); }).join(" ");

				return { "start": statement.getStart(sourceFile), "end": statement.getEnd(), "kind": ts.SyntaxKind[statement.kind], ...comment === "" ? {} : { "comment": comment }, ...describeStatement(statement, sourceFile, typeOf) };
			}) }, "responseRequired": true };
		});
	}

	/** A statement as a card says it: a title (the names it declares, or what it calls), a detail (how), and the types
	 *  of what it declares. */
	function describeStatement(statement, sourceFile, typeOf) {
		function text(node) {
			return node.getText(sourceFile).replace(/\s+/gu, " ");
		}

		// The callee of a call, however it's reached (`await f()`, `x = f()`, `f().then(…)` is `…then`).
		function calleeOf(expression) {
			let node = expression;

			while (node !== undefined && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isVoidExpression(node))) {
				node = node.expression;
			}

			return node !== undefined && ts.isCallExpression(node) ? text(node.expression) : undefined;
		}

		// The names a binding declares — `[, , country = "CA", coupon]` is country and coupon.
		function namesOf(name) {
			return ts.isIdentifier(name) ? [name] : name.elements.flatMap(function(element) { return ts.isOmittedExpression(element) ? [] : namesOf(element.name); });
		}

		if (ts.isVariableStatement(statement)) {
			const declarations = statement.declarationList.declarations;
			const flags = statement.declarationList.flags;
			const keyword = (flags & ts.NodeFlags.Const) !== 0 ? "const" : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
			const callee = declarations.length === 1 && declarations[0].initializer !== undefined ? calleeOf(declarations[0].initializer) : undefined;

			const names = declarations.flatMap(function(declaration) { return namesOf(declaration.name); });

			return {
				"title": names.map(function(name) { return name.text; }).join(", "),
				"detail": callee === undefined ? keyword : keyword + " · " + callee + "()",
				"declares": names.map(function(name) { return { "name": name.text, "type": typeOf(name) }; })
			};
		}

		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
			const name = statement.name === undefined ? "(anonymous)" : statement.name.text;
			const isAsync = ts.isFunctionDeclaration(statement) && statement.modifiers !== undefined && statement.modifiers.some(function(modifier) { return modifier.kind === ts.SyntaxKind.AsyncKeyword; });

			return { "title": name, "detail": ts.isClassDeclaration(statement) ? "class" : isAsync ? "async function" : "function", "declares": statement.name === undefined ? [] : [{ "name": name, "type": typeOf(statement.name) }] };
		}

		if (ts.isImportDeclaration(statement)) {
			return { "title": ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : text(statement.moduleSpecifier), "detail": "import" };
		}

		if (ts.isExpressionStatement(statement)) {
			const expression = statement.expression;

			if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const callee = calleeOf(expression.right);

				return { "title": text(expression.left), "detail": callee === undefined ? "assigned" : "assigned · " + callee + "()" };
			}

			const callee = calleeOf(expression);

			return callee === undefined ? { "title": text(expression).slice(0, 40), "detail": "expression" } : { "title": callee, "detail": "call" };
		}

		if (ts.isIfStatement(statement)) {
			return { "title": "if " + text(statement.expression).slice(0, 40), "detail": "branch" };
		}

		if (ts.isIterationStatement(statement, false)) {
			return { "title": text(statement).split("{")[0].trim().slice(0, 40), "detail": "loop" };
		}

		return { "title": ts.SyntaxKind[statement.kind].replace(/Statement$|Declaration$/u, "").toLowerCase(), "detail": "" };
	}

	return {
		"create": function(info) {
			applyConfig(info.config);
			registerTypesAt(info);

			const ls = info.languageService;
			const proxy = Object.create(null);

			for (const key of Object.keys(ls)) {
				proxy[key] = function(...args) {
					return ls[key].apply(ls, args);
				};
			}

			proxy.getSemanticDiagnostics = function(fileName) {
				const prior = ls.getSemanticDiagnostics(fileName);
				const program = ls.getProgram();
				const sourceFile = program === undefined ? undefined : program.getSourceFile(fileName);

				if (sourceFile === undefined) {
					return prior;
				}

				try {
					// Kick a background canary run if this text hasn't been observed yet.
					maybeRunCanary(fileName, sourceFile.text, info);

					const cachedCanary = canaryCache.get(fileName);
					const observations = cachedCanary !== undefined && cachedCanary.text === sourceFile.text ? cachedCanary.observations : [];
					const observationByStart = new Map();

					for (const observation of observations) {
						observationByStart.set(observation.start, observation);
					}

					const staticStarts = new Set();

					// STATIC rows (recomputed on text change), enriched with the canary's runtime value where present.
					if (engine !== undefined) {
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
							staticStarts.add(row.start);
							prior.push({
								"file": sourceFile,
								"start": row.start,
								"length": Math.max(0, row.end - row.start),
								"code": 900100,
								"category": categoryOf(row.dangerous),
								"source": "capabilities",
								"messageText": messageOf(row, observationByStart.get(row.start))
							});
						}
					}

					// CANARY-only findings: dynamic calls the static half never emitted a row for (its resource wasn't
					// a literal). These carry the runtime value the static half couldn't resolve.
					for (const observation of observations) {
						if (!staticStarts.has(observation.start)) {
							prior.push({
								"file": sourceFile,
								"start": observation.start,
								"length": Math.max(0, observation.end - observation.start),
								"code": 900100,
								"category": categoryOf(observation.dangerous),
								"source": "capabilities",
								"messageText": canaryMessage(observation)
							});
						}
					}
				} catch (error) { /* capability analysis is best-effort — never break tsserver's own diagnostics */ }

				return prior;
			};

			return proxy;
		},
		"onConfigurationChanged": function(config) { applyConfig(config); }
	};
}
