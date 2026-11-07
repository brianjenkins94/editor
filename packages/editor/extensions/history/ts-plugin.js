/**
 * History TypeScript Server Plugin — reads the program the in-browser TypeScript server already holds, edits as they're
 * typed included, with the server's own `ts`: each file's ways in and its part of the declaration graph (util/silo's
 * ts-analysis, the same reading `silo history --analyzer typescript` does with TypeScript 7). No copy of TypeScript, no
 * oxc: the engine (history-engine.js, served beside this file) is built with `typescript` external, and we hand it ours.
 *
 * One request (through `typescript.tsserverRequest`), `_history.read`: the extension says which reading of each file it
 * has (a revision number this plugin gave it), and `rescan` when files were made or deleted since (the projects read their
 * files again first); the answer is every file whose reading is newer — it changed, or a file it resolves names into
 * did — and every file there is now. Readings are kept here between requests, so an answer costs only what changed.
 *
 * And `_history.fileRename`: the edits a file's move makes (workbench/code-refactor.ts, Refactoring for agents), as only a
 * plugin can ask the server for them in the browser.
 *
 * How it's loaded: registered as extension files whose extension-file:// probe URIs
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

	// A rescan (`_history.read`'s `rescan`): files made or deleted on disk, told to the projects (the browser server isn't).
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

	// `_history.fileRename`: the edits a file's move makes, its importers' and its own (workbench/code-refactor.ts).
	function projectsOf(projectService) {
		return [...projectService.configuredProjects ? projectService.configuredProjects.values() : [], ...projectService.inferredProjects || []];
	}

	/** The workspace path (`/workspace/…`) a server file name is: the browser server names a file by its URI. */
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

		// (a file it hasn't, or one not there yet: named as its other files are)
		const sample = program.getRootFileNames()[0];

		return sample !== undefined && sample !== workspacePathOf(sample) ? sample.slice(0, sample.length - workspacePathOf(sample).length) + path : path;
	}

	/**
	 * What moving `from` to `to` (workspace paths, a file's or a folder's) changes in the code: TypeScript's edits for it
	 * (`getEditsForFileRename`), every import of it in each project holding it and its own relative imports, at the old
	 * path, as each file's spans and their new text. `outside` when no project holds `from`.
	 */
	function fileRename(projectService, args) {
		const from = typeof args.from === "string" ? args.from : "";
		const to = typeof args.to === "string" ? args.to : "";
		const edits = new Map();
		let held = false;

		for (const project of projectsOf(projectService)) {
			const service = project.getLanguageService();
			const program = service.getProgram();

			if (program === undefined || !program.getSourceFiles().some(function(source) {
				const path = workspacePathOf(source.fileName);

				return path === from || path.startsWith(from + "/");
			})) {
				continue;
			}

			held = true;

			for (const change of service.getEditsForFileRename(serverNameOf(program, from), serverNameOf(program, to), {}, { "allowTextChangesInNewFiles": true })) {
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
				// Files made or deleted since: told to the projects (`filesChanged`), as a refactoring wants every file it touches held.
				info.session.addProtocolHandler("_history.files", function() {
					try {
						return { "response": filesChanged(info.project.projectService), "responseRequired": true };
					} catch (error) {
						return { "response": { "error": String(error && error.stack || error) }, "responseRequired": true };
					}
				});
				// (a failure is answered, not thrown: the server's own error says only that one happened)
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
