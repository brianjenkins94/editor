/**
 * History TypeScript Server Plugin — reads the program the in-browser TypeScript server already holds, edits as they're
 * typed included, with the server's own `ts`: each file's ways in and its part of the declaration graph (util/silo's
 * ts-analysis, the same reading `silo history --analyzer typescript` does with TypeScript 7). No copy of TypeScript, no
 * oxc: the engine (history-engine.js, served beside this file) is built with `typescript` external, and we hand it ours.
 *
 * One request, `_history.read` (through `typescript.tsserverRequest`): the extension says which reading of each file it
 * has (a revision number this plugin gave it); the answer is every file whose reading is newer — it changed, or a file it
 * resolves names into did — and every file there is now. Readings are kept here between requests, so an answer costs
 * only what changed.
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
		const path = uri === null ? fileName : uri[1] === "file" ? uri[3] : undefined;

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

			if (program === undefined) {
				continue;
			}

			for (const source of program.getSourceFiles()) {
				const path = relativeTo(root, source.fileName);

				if (path !== undefined && !source.isDeclarationFile && !files.has(path)) {
					files.set(path, { "program": program, "source": source, "version": String(source.version ?? project.getScriptVersion(source.fileName) ?? "") });
				}
			}
		}

		return files;
	}

	function read(info, args) {
		if (engine === undefined) {
			return { "ready": false, "error": engineError };
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

	return {
		"create": function(info) {
			if (!registered && info.session !== undefined && typeof info.session.addProtocolHandler === "function") {
				registered = true;
				info.session.addProtocolHandler("_history.read", function(request) {
					return { "response": read(info, (request && request.arguments) || {}), "responseRequired": true };
				});
			}

			return info.languageService;
		}
	};
}
