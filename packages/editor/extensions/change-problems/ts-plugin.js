/**
 * A change's problems' TypeScript server plugin — TypeScript's side of `code.problems` (workbench/code-problems.ts),
 * with the server's own `ts`, over the program it already holds. Two requests (through `typescript.tsserverRequest`):
 *
 * - `_changeProblems.files`: files were made or deleted, so each configured project reads its root files again before
 *   the comparison (the browser server isn't told: its watchers watch nothing), so a file the change made is in it.
 * - `_changeProblems.compare`: TypeScript's diagnostics for the files a change touches, now and at HEAD, so core can say
 *   which the change added and which it cleared. Its arguments: `files` (each changed file, as the server names it, and
 *   its text at HEAD, or null when HEAD hasn't it), `depth` (rings of importers checked besides: 0 or 1, by default 1) and
 *   `limit` (files checked at most, by default 100). The answer: per project holding a changed file, the files checked and
 *   each one's diagnostics now and at HEAD, and the importers it didn't check. HEAD is a second language service over the
 *   same project: the project's host, but HEAD's text for the changed files and its own module resolution (the project's
 *   cache is its to keep). Its documents come from the project's registry, so a file the change didn't touch isn't parsed
 *   again; a changed file's HEAD text has a registry of its own.
 *
 * Bundled into its extension's folder as the package the TypeScript extension loads it from
 * (node_modules/change-problems-ts-plugin/), as an extension's files are served.
 */
export default function init(modules) {
	const ts = modules.typescript;
	let registered = false;

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

	/** The workspace path (`/workspace/…`) a server file name is: the browser server names a file by its URI
	 *  (`/file/ts-nul-authority/workspace/…`). */
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

	// `_changeProblems.files`: files made or deleted on disk, told to the projects (the browser server isn't told).
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

	return {
		"create": function(info) {
			if (!registered && info.session !== undefined && typeof info.session.addProtocolHandler === "function") {
				registered = true;
				// (a failure is answered, not thrown: the server's own error says only that one happened)
				info.session.addProtocolHandler("_changeProblems.files", function() {
					try {
						return { "response": filesChanged(info.project.projectService), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.stack || error) }, "responseRequired": true };
					}
				});
				info.session.addProtocolHandler("_changeProblems.compare", function(request) {
					try {
						return { "response": compare(info.project.projectService, (request && request.arguments) || {}), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.stack || error) }, "responseRequired": true };
					}
				});
			}

			return info.languageService;
		}
	};
}
