/**
 * History TypeScript Server Plugin — reads the program the in-browser TypeScript server already holds, edits as they're
 * typed included, with the server's own `ts`: each file's ways in and its part of the declaration graph (util/silo's
 * ts-analysis, the same reading `silo history --analyzer typescript` does with TypeScript 7). No copy of TypeScript, no
 * oxc: the engine (history-engine.js, served beside this file) is built with `typescript` external, and we hand it ours.
 *
 * Five requests (through `typescript.tsserverRequest`):
 *
 * - `_history.read`: the extension says which reading of each file it has (and `rescan`, when files were made or
 *   deleted since: the projects read their files again first) (a revision number this plugin gave it); the
 *   answer is every file whose reading is newer — it changed, or a file it resolves names into did — and every file
 *   there is now. Readings are kept here between requests, so an answer costs only what changed.
 * - `_history.files`, core's (ts-projects.ts): files were made or deleted, so each configured project reads its root
 *   files again (the browser server isn't told: its watchers watch nothing).
 * - `_history.query`, core's (code-refactor.ts): where a structural pattern matches (the engine's patterns.ts), in the
 *   workspace files the projects hold, and with `replace` its rewrite's edits.
 * - `_history.fileRename`, core's (code-refactor.ts): the edits moving a file makes, TypeScript's
 *   `getEditsForFileRename` (every import of it, and its own relative imports), as each file's spans and new text.
 * - `_history.problems`, core's (code-problems.ts): TypeScript's diagnostics for the files a change touches, now and at
 *   HEAD, so core can say which the change added and which it cleared. Its arguments: `files` (each changed file, as the
 *   server names it, and its text at HEAD, or null when HEAD hasn't it), `depth` (rings of importers checked besides: 0
 *   or 1, by default 1) and `limit` (files checked at most, by default 100). The answer: per project holding a changed
 *   file, the files checked and each one's diagnostics now and at HEAD, and the importers it didn't check. HEAD is a
 *   second language service over the same project: the project's host, but HEAD's text for the changed files and its
 *   own module resolution (the project's cache is its to keep). Its documents come from the project's registry, so a
 *   file the change didn't touch isn't parsed again; a changed file's HEAD text has a registry of its own.
 *
 * How it's loaded: as eslint's and capabilities' are — registered as extension files whose extension-file:// probe URIs
 * the extension host's patched fetch/importExt resolves; this file is served, so its import.meta.url finds the engine.
 */

export default function init(modules) {
	const ts = modules.typescript;

	// Hand the (typescript-external) engine tsserver's own `ts` — its shim reads this at load.
	try {
		globalThis.__historyTs = ts;
	} catch (error) { /* non-fatal */ }

	// Bundler-proof native dynamic import of the served engine URL from inside the tsserver worker.
	// eslint-disable-next-line no-new-func
	const importUrl = new Function("u", "return import(u);");
	let engine;
	let engineError;

	try {
		importUrl(new URL("./history-engine.js", import.meta.url).href).then(function(module) {
			engine = module;
		}).catch(function(error) {
			engineError = String((error && error.message) || error);
		});
	} catch (error) {
		engineError = String((error && error.message) || error);
	}

	/**
	 * A server file name as a path relative to `root`, or undefined for one that isn't the workspace's own source. In the
	 * browser the server names a file by its URI — `/<scheme>/<authority>/<path>` (`/file/ts-nul-authority/workspace/…`;
	 * Source Control's HEAD copies are `/git-head/…`) — and only the `file` scheme is the workspace; a desktop server's
	 * names are plain paths.
	 */
	function relativeTo(root, fileName) {
		const uri = /^\/([a-z][a-z0-9+.-]*)\/([^/]+)(\/.*)$/u.exec(fileName);
		let path = fileName;

		if (uri !== null) {
			path = uri[1] === "file" ? uri[3] : undefined;
		}

		return path !== undefined && path.startsWith(root + "/") && !path.includes("/node_modules/") ? path.slice(root.length + 1) : undefined;
	}

	// Each file's reading, by its path relative to the root: { analysis (its `version` the file's), revision }.
	const readings = new Map();
	let revisions = 0;
	let registered = false;

	/** Every program the server holds, each source file in `root` once (the first project that has it). */
	function programFiles(projectService, root) {
		const files = new Map();
		const projects = [...(projectService.configuredProjects ? projectService.configuredProjects.values() : []), ...(projectService.inferredProjects || [])];

		for (const project of projects) {
			const program = project.getLanguageService().getProgram();

			if (program !== undefined) {
				for (const source of program.getSourceFiles()) {
					const path = relativeTo(root, source.fileName);

					if (path !== undefined && !source.isDeclarationFile && !files.has(path)) {
						files.set(path, { "program": program, "source": source, "version": String(source.version ?? project.getScriptVersion(source.fileName) ?? "") });
					}
				}
			}
		}

		return files;
	}

	function read(info, args) {
		if (engine === undefined) {
			return { "ready": false, "error": engineError };
		}

		// (files made or deleted on disk since the last reading: the projects read their files again first)
		if (args.rescan === true) {
			filesChanged(info.project.projectService);
		}

		const root = String(args.root || "/workspace").replace(/\/+$/u, "");
		const known = args.known && typeof args.known === "object" ? args.known : {};
		const files = programFiles(info.project.projectService, root);
		const changed = new Set();

		for (const [path, file] of files) {
			const reading = readings.get(path);

			if (reading === undefined || reading.analysis.version !== file.version) {
				changed.add(path);
			}
		}

		for (const path of readings.keys()) {
			if (!files.has(path)) {
				changed.add(path);
				readings.delete(path);
			}
		}

		// One host per program: names resolve in the program that has the file.
		const hosts = new Map();

		function hostFor(program) {
			let host = hosts.get(program);

			if (host === undefined) {
				host = engine.classicHost(ts, program, function(fileName) {
					return relativeTo(root, fileName);
				});
				hosts.set(program, host);
			}

			return host;
		}

		const answer = {};

		for (const [path, file] of files) {
			const reading = readings.get(path);

			if (engine.stale(reading === undefined ? undefined : reading.analysis, file.version, changed)) {
				let analysis;

				try {
					analysis = engine.analyzeFile(hostFor(file.program), path, file.source, file.source.text, file.version);
				} catch (error) {
					analysis = { "version": file.version, "ways": [], "declarations": {}, "imports": {}, "namespaces": {}, "modules": [], "dependsOn": [], "error": String((error && error.message) || error) };
				}

				revisions += 1;
				readings.set(path, { "analysis": analysis, "revision": revisions });
			}

			if (known[path] !== readings.get(path).revision) {
				answer[path] = readings.get(path);
			}
		}

		return { "ready": true, "files": answer, "paths": [...files.keys()] };
	}

	// `_history.problems`: a change's TypeScript problems, now and at HEAD.
	const SEVERITIES = { [ts.DiagnosticCategory.Error]: "error", [ts.DiagnosticCategory.Warning]: "warning", [ts.DiagnosticCategory.Suggestion]: "hint", [ts.DiagnosticCategory.Message]: "info" };

	function projectsOf(projectService) {
		return [...projectService.configuredProjects ? projectService.configuredProjects.values() : [], ...projectService.inferredProjects || []];
	}

	/** Each file's importers in `program` (by the server's path): the files whose imports resolve to it. */
	function importersOf(program) {
		const importers = new Map();

		for (const source of program.getSourceFiles()) {
			if (source.isDeclarationFile || /\/node_modules\//u.test(source.fileName)) {
				continue;
			}

			for (const specifier of source.imports || []) {
				const resolved = typeof program.getResolvedModule === "function" ? program.getResolvedModule(source, specifier.text, program.getModeForUsageLocation(source, specifier)) : undefined;
				const target = resolved && resolved.resolvedModule && resolved.resolvedModule.resolvedFileName;

				if (target !== undefined && target !== source.fileName) {
					if (!importers.has(target)) {
						importers.set(target, new Set());
					}

					importers.get(target).add(source.fileName);
				}
			}
		}

		return importers;
	}

	/** The project's host, but HEAD's text for the changed files (`head`: path → text, or null where HEAD hasn't it);
	 *  `deleted`, the files HEAD had that the change deleted, among this project's. */
	function headHost(project, head, deleted) {
		const host = Object.create(project);
		const roots = new Set(project.getScriptFileNames());

		for (const [path, text] of head) {
			if (text === null) {
				roots.delete(path);
			}
		}

		for (const path of deleted) {
			roots.add(path);
		}

		host.getProjectVersion = function() {
			return "head";
		};

		host.getScriptFileNames = function() {
			return [...roots];
		};

		host.getScriptVersion = function(path) {
			return head.has(path) ? "head" : project.getScriptVersion(path);
		};

		host.getScriptSnapshot = function(path) {
			if (head.has(path)) {
				return head.get(path) === null ? undefined : ts.ScriptSnapshot.fromString(head.get(path));
			}

			return project.getScriptSnapshot(path);
		};

		host.fileExists = function(path) {
			return head.has(path) ? head.get(path) !== null : project.fileExists(path);
		};

		host.readFile = function(path, encoding) {
			return head.has(path) ? head.get(path) ?? undefined : project.readFile(path, encoding);
		};

		// (a project's language service syncs by updating the project: this one makes its own program)
		host.updateFromProject = undefined;
		// (resolved afresh, from the host's files: the project's resolution cache follows its own program)
		host.resolveModuleNameLiterals = undefined;
		host.resolveModuleNames = undefined;
		host.resolveTypeReferenceDirectiveReferences = undefined;
		host.resolveTypeReferenceDirectives = undefined;
		host.getModuleResolutionCache = undefined;
		host.hasInvalidatedResolutions = undefined;

		return host;
	}

	/** The project's document registry for the files the change didn't touch, and one of its own for those it did. */
	function headRegistry(project, head) {
		const shared = project.documentRegistry || project.projectService.documentRegistry;
		const own = ts.createDocumentRegistry(project.useCaseSensitiveFileNames(), project.getCurrentDirectory());

		if (shared === undefined) {
			return own;
		}

		function pick(path) {
			return head.has(path) ? own : shared;
		}

		return {
			"acquireDocument": function(path, ...rest) {
				return pick(path).acquireDocument(path, ...rest);
			},
			"acquireDocumentWithKey": function(path, ...rest) {
				return pick(path).acquireDocumentWithKey(path, ...rest);
			},
			"updateDocument": function(path, ...rest) {
				return pick(path).updateDocument(path, ...rest);
			},
			"updateDocumentWithKey": function(path, ...rest) {
				return pick(path).updateDocumentWithKey(path, ...rest);
			},
			"releaseDocument": function(path, ...rest) {
				return pick(path).releaseDocument(path, ...rest);
			},
			"releaseDocumentWithKey": function(path, ...rest) {
				return pick(path).releaseDocumentWithKey(path, ...rest);
			},
			"getKeyForCompilationSettings": function(settings) {
				return shared.getKeyForCompilationSettings(settings);
			},
			"getDocumentRegistryBucketKeyWithMode": shared.getDocumentRegistryBucketKeyWithMode === undefined ? undefined : function(...args) {
				return shared.getDocumentRegistryBucketKeyWithMode(...args);
			},
			"reportStats": function() {
				return shared.reportStats();
			}
		};
	}

	/** A file's diagnostics in `service`, as data: syntactic and semantic, each with its 1-based line and column. */
	function diagnosticsOf(service, path) {
		const program = service.getProgram();
		const source = program === undefined ? undefined : program.getSourceFile(path);

		if (source === undefined) {
			return undefined;
		}

		return [...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path)].map(function(diagnostic) {
			const start = diagnostic.start === undefined ? 0 : diagnostic.start;
			const at = source.getLineAndCharacterOfPosition(start);

			return {
				"line": at.line + 1,
				"column": at.character + 1,
				"length": diagnostic.length === undefined ? 0 : diagnostic.length,
				"code": diagnostic.code,
				"severity": SEVERITIES[diagnostic.category] || "info",
				"message": ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
			};
		});
	}

	/** The workspace path (`/workspace/…`) a server file name is: the browser server names a file by its URI (relativeTo). */
	function workspacePathOf(fileName) {
		const uri = /^\/file\/[^/]+(\/.*)$/u.exec(fileName);

		return uri === null ? fileName : uri[1];
	}

	/** What `program`'s server names a workspace path: as its files are named (by URI in the browser, else plainly). */
	function serverNameOf(program, path) {
		if (program.getSourceFile(path) !== undefined) {
			return path;
		}

		const named = program.getSourceFiles().find(function(source) {
			return source.fileName.endsWith(path) && workspacePathOf(source.fileName) === path;
		});

		if (named !== undefined) {
			return named.fileName;
		}

		// (a file it hasn't, a deleted one: named as its other files are)
		const sample = program.getRootFileNames()[0];

		return sample !== undefined && sample !== workspacePathOf(sample) ? sample.slice(0, sample.length - workspacePathOf(sample).length) + path : path;
	}

	function compare(projectService, args) {
		const requested = new Map(Object.entries(args.files && typeof args.files === "object" ? args.files : {}).map(function(entry) {
			return [entry[0], typeof entry[1] === "string" ? entry[1] : null];
		}));
		const depth = args.depth === 0 ? 0 : 1;
		const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 100;
		const answer = [];
		const placed = new Set();

		for (const project of projectsOf(projectService)) {
			const service = project.getLanguageService();
			const program = service.getProgram();

			if (program === undefined) {
				continue;
			}

			// (the changed files by this server's names; a deleted one is the project's if it would be: in its folder)
			const head = new Map([...requested].map(function(entry) {
				return [serverNameOf(program, entry[0]), entry[1]];
			}));
			const directory = workspacePathOf(project.getCurrentDirectory()).replace(/\/?$/u, "/");
			const changed = [...head.keys()].filter(function(name) {
				return !placed.has(workspacePathOf(name)) && (program.getSourceFile(name) !== undefined || (head.get(name) !== null && workspacePathOf(name).startsWith(directory) && project.projectKind === ts.server.ProjectKind.Configured));
			});

			if (changed.length === 0) {
				continue;
			}

			for (const name of changed) {
				placed.add(workspacePathOf(name));
			}

			const importers = importersOf(program);

			function importing(names) {
				return names.flatMap(function(name) {
					return [...importers.get(name) || []];
				});
			}

			const ring = depth === 0 ? [] : [...new Set(importing(changed))].filter(function(name) {
				return !head.has(name);
			});
			const files = [...changed, ...ring].slice(0, limit);
			const unchecked = [...changed, ...ring].slice(limit);
			const deleted = changed.filter(function(name) {
				return program.getSourceFile(name) === undefined;
			});
			const before = ts.createLanguageService(headHost(project, head, deleted), headRegistry(project, head));
			const checked = [];

			try {
				for (const name of files) {
					checked.push({ "file": workspacePathOf(name), "now": diagnosticsOf(service, name) || null, "head": diagnosticsOf(before, name) || null });
				}
			} finally {
				before.dispose();
			}

			// (beyond the depth: the next ring's size, so the answer says what it left)
			const further = importing(depth === 0 ? changed : ring);

			answer.push({
				"project": project.getProjectName(),
				"checked": checked,
				"unchecked": unchecked.map(workspacePathOf),
				"beyond": new Set(further.filter(function(name) {
					return !files.includes(name) && !unchecked.includes(name);
				})).size
			});
		}

		return {
			"projects": answer,
			"outside": [...requested.keys()].filter(function(path) {
				return !placed.has(path);
			})
		};
	}

	// `_history.files`: files made or deleted on disk, told to the projects (the browser server isn't: ts-projects.ts).
	/**
	 * Every configured project's root files read again from its tsconfig, at its next update, as the server's own watcher
	 * does on a change in a folder it includes (`RootNamesAndUpdate`): a file made joins its project, a deleted one
	 * leaves. The program updates as it does for an edit, not from scratch. How many projects were told.
	 */
	function filesChanged(projectService) {
		const rootNames = ts.ProgramUpdateLevel === undefined ? 1 : ts.ProgramUpdateLevel.RootNamesAndUpdate;
		let told = 0;

		for (const project of projectService.configuredProjects ? projectService.configuredProjects.values() : []) {
			// (the file names come from the parsed config, re-read only when its own update level says so, through its
			// cache of the folders' listings: both, as the server's watcher would on a folder's change)
			const existence = projectService.configFileExistenceInfoCache && projectService.configFileExistenceInfoCache.get(project.canonicalConfigFilePath);
			const config = existence && existence.config;

			if (config !== undefined) {
				if (config.updateLevel === undefined || config.updateLevel < rootNames) {
					config.updateLevel = rootNames;
				}

				if (config.cachedDirectoryStructureHost && typeof config.cachedDirectoryStructureHost.clearCache === "function") {
					config.cachedDirectoryStructureHost.clearCache();
				}
			}

			if (project.pendingUpdateLevel === undefined || project.pendingUpdateLevel < rootNames) {
				project.pendingUpdateLevel = rootNames;
			}

			project.markAsDirty();
			told += 1;
		}

		return { "projects": told };
	}

	// `_history.query`: where a structural pattern matches, and its rewrite's edits.
	/**
	 * Every workspace file the projects hold (in `paths`, files or folders, when given) where `pattern` matches
	 * (patterns.ts): each match's line, column, first line of text and bindings, and with `replace`, the rewrite's edits
	 * (outermost matches). `searched` is how many files were looked at: only what the projects hold.
	 */
	function query(projectService, args) {
		if (engine === undefined) {
			return { "ready": false, ...engineError === undefined ? {} : { "error": engineError } };
		}

		const pattern = engine.patternNode(ts, String(args.pattern || ""));
		const paths = Array.isArray(args.paths) ? args.paths.map(function(each) {
			return String(each).replace(/^\/workspace\//u, "").replace(/\/+$/u, "");
		}) : undefined;
		const seen = new Set();
		const files = [];

		for (const project of projectsOf(projectService)) {
			const program = project.getLanguageService().getProgram();

			for (const source of program === undefined ? [] : program.getSourceFiles()) {
				const path = workspacePathOf(source.fileName);
				const file = path.startsWith("/workspace/") ? path.slice("/workspace/".length) : undefined;

				if (file === undefined || source.isDeclarationFile || /(?:^|\/)node_modules\//u.test(file) || seen.has(file) || (paths !== undefined && !paths.some(function(each) {
					return file === each || file.startsWith(each + "/");
				}))) {
					continue;
				}

				seen.add(file);

				const matched = engine.matchPattern(ts, pattern, source);

				if (matched.length > 0) {
					files.push({
						"file": file,
						"matches": matched.map(function(match) {
							const at = source.getLineAndCharacterOfPosition(match.start);

							return { "line": at.line + 1, "column": at.character + 1, "text": source.text.slice(match.start, match.end).split("\n")[0].slice(0, 200), "bindings": match.bindings };
						}),
						...typeof args.replace === "string" ? { "edits": engine.rewrites(matched, args.replace) } : {}
					});
				}
			}
		}

		return { "ready": true, "files": files, "searched": seen.size };
	}

	// `_history.fileRename`: the edits a file's move makes, its importers' and its own.
	/**
	 * What moving `from` to `to` (workspace paths) changes in the code: TypeScript's edits for the rename
	 * (`getEditsForFileRename`) — every import of it, in each project holding it, and its own relative imports, at its
	 * old path — as each file's spans and their new text, by workspace path. `outside` when no project holds `from`.
	 */
	function fileRename(projectService, args) {
		const from = typeof args.from === "string" ? args.from : "";
		const to = typeof args.to === "string" ? args.to : "";
		const edits = new Map();
		let held = false;

		for (const project of projectsOf(projectService)) {
			const service = project.getLanguageService();
			const program = service.getProgram();
			const old = program === undefined ? undefined : serverNameOf(program, from);

			if (old === undefined || program.getSourceFile(old) === undefined) {
				continue;
			}

			held = true;

			for (const change of service.getEditsForFileRename(old, serverNameOf(program, to), {}, { "allowTextChangesInNewFiles": true })) {
				const file = workspacePathOf(change.fileName);
				const known = edits.get(file) || new Map();

				// (the same edit from two projects, once)
				for (const text of change.textChanges) {
					known.set(`${String(text.span.start)}:${String(text.span.length)}`, { "start": text.span.start, "length": text.span.length, "text": text.newText });
				}

				edits.set(file, known);
			}
		}

		return {
			"edits": [...edits].map(function(entry) {
				return { "file": entry[0], "changes": [...entry[1].values()] };
			}),
			...held ? {} : { "outside": true }
		};
	}

	return {
		"create": function(info) {
			if (!registered && info.session !== undefined && typeof info.session.addProtocolHandler === "function") {
				registered = true;
				info.session.addProtocolHandler("_history.read", function(request) {
					return { "response": read(info, (request && request.arguments) || {}), "responseRequired": true };
				});
				// (a failure is answered, not thrown: the server's own error says only that one happened)
				info.session.addProtocolHandler("_history.problems", function(request) {
					try {
						return { "response": compare(info.project.projectService, (request && request.arguments) || {}), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.stack || error) }, "responseRequired": true };
					}
				});
				info.session.addProtocolHandler("_history.files", function() {
					try {
						return { "response": filesChanged(info.project.projectService), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.stack || error) }, "responseRequired": true };
					}
				});
				info.session.addProtocolHandler("_history.query", function(request) {
					try {
						return { "response": query(info.project.projectService, (request && request.arguments) || {}), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.message || error) }, "responseRequired": true };
					}
				});
				info.session.addProtocolHandler("_history.fileRename", function(request) {
					try {
						return { "response": fileRename(info.project.projectService, (request && request.arguments) || {}), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.stack || error) }, "responseRequired": true };
					}
				});
			}

			return info.languageService;
		}
	};
}
