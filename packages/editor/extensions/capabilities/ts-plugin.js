/**
 * Capabilities TypeScript Server Plugin — the capability IDE's readings, answered from the trees the in-browser tsserver
 * already holds, with its own `ts` and checker. It only answers requests (through `typescript.tsserverRequest`); what
 * it computes is the engine's (engine.ts, over lib's util/silo), so the same readings run wherever a tree is — the
 * extension shows them. (When the editor's TypeScript is 7, an API connection to the server replaces this plugin: the
 * silo README's "Where analysis lives when TypeScript 7 arrives".)
 *
 * - `_capabilities.findings` — a file's capability findings (engine.findings): the static half (every call with a
 *   literal resource, typed by the checker) merged with the canary's observations. The canary (canary.ts, tsval) runs
 *   the module in the background — async, bounded by a tsval step budget — for the resources the static half can't see;
 *   while it runs, the answer says `pending`, and the extension asks again. The canary needs `typescript`, so it's built
 *   with ts EXTERNAL and handed tsserver's own via `globalThis.__capabilitiesTs`.
 * - `_capabilities.surface` — every source file's import surface across the programs the server holds, for the
 *   baseline's `consumer` (baseline.ts).
 * - `_types.at` — the type of each of a file's ranges (runtime evidence's declared types; RUNTIME-EVIDENCE.md).
 * - `_statements` — a file's top-level statements as a projection's cards (RUNTIME-EVIDENCE.md, *Projections*).
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

	// Canary observations are async; cache per file (keyed by exact text) and never re-run while a run is in flight.
	const canaryCache = new Map();
	const canaryInFlight = new Set();

	function maybeRunCanary(fileName, text) {
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
		});
	}

	/**
	 * A server file name as a path relative to `root`, or undefined for one that isn't the workspace's own source. In the
	 * browser the server names a file by its URI — `/<scheme>/<authority>/<path>` (`/file/ts-nul-authority/workspace/…`;
	 * Source Control's HEAD copies are `/git-head/…`) — and only the `file` scheme is the workspace; a desktop server's
	 * names are plain paths. (As the history plugin reads them.)
	 */
	function relativeTo(root, fileName) {
		const uri = /^\/([a-z][a-z0-9+.-]*)\/([^/]+)(\/.*)$/u.exec(fileName);
		let path = fileName;

		if (uri !== null) {
			path = uri[1] === "file" ? uri[3] : undefined;
		}

		return path !== undefined && path.startsWith(root + "/") && !path.includes("/node_modules/") ? path.slice(root.length + 1) : undefined;
	}

	/** Every source file in `root` the server's programs hold — each once (the first project that has it) — with its
	 *  import surface (engine.surface): the workspace's own code's use of its dependencies. Not ready until the engine is. */
	function surfaces(projectService, root) {
		if (engine === undefined) {
			return { "ready": false, "error": engineError };
		}

		const files = {};
		const projects = [...(projectService.configuredProjects ? projectService.configuredProjects.values() : []), ...(projectService.inferredProjects || [])];

		for (const project of projects) {
			const program = project.getLanguageService().getProgram();

			for (const source of program === undefined ? [] : program.getSourceFiles()) {
				const path = relativeTo(root, source.fileName);

				if (path !== undefined && !source.isDeclarationFile && files[path] === undefined) {
					try {
						files[path] = engine.surface(ts, source);
					} catch (error) { /* a file it can't read: no surface of it */ }
				}
			}
		}

		return { "ready": projects.length > 0, "files": files };
	}

	// The requests: registered once per tsserver, from the first project that has a session; each request finds its
	// file's own project.
	let registered = false;

	function registerRequests(info) {
		if (registered || info.session === undefined || typeof info.session.addProtocolHandler !== "function") {
			return;
		}

		registered = true;
		// `_capabilities.surface` — every source file's import surface, for the baseline's `consumer` (baseline.ts).
		info.session.addProtocolHandler("_capabilities.surface", function(request) {
			const args = (request && request.arguments) || {};

			return { "response": surfaces(info.project.projectService, String(args.root || "/workspace").replace(/\/+$/u, "")), "responseRequired": true };
		});
		// `_capabilities.findings` — a file's capability findings, for the extension to show (findings.ts).
		info.session.addProtocolHandler("_capabilities.findings", function(request) {
			const at = fileOf(info, request);

			if (engine === undefined || at.sourceFile === undefined) {
				return { "response": { "ready": false, ...engineError === undefined ? {} : { "error": engineError } }, "responseRequired": true };
			}

			// (a background canary run, if this text hasn't been observed yet)
			maybeRunCanary(at.path, at.sourceFile.text);

			const cached = canaryCache.get(at.path);
			const observations = cached !== undefined && cached.text === at.sourceFile.text ? cached.observations : [];

			return { "response": { "ready": true, "findings": engine.findings(ts, at.sourceFile, at.program.getTypeChecker(), observations), "pending": canaryInFlight.has(at.path) }, "responseRequired": true };
		});
		// `_types.at` — each of a file's ranges as TypeScript types it (null where no node has the range).
		info.session.addProtocolHandler("_types.at", function(request) {
			const at = fileOf(info, request);
			const ranges = Array.isArray(request && request.arguments && request.arguments.ranges) ? request.arguments.ranges : [];

			const types = engine === undefined || at.sourceFile === undefined ? ranges.map(function() {
				return null;
			}) : engine.typesAt(ts, at.program.getTypeChecker(), at.sourceFile, ranges);

			return { "response": { "types": types }, "responseRequired": true };
		});
		// `_statements` — a file's top-level statements, as a projection's cards.
		info.session.addProtocolHandler("_statements", function(request) {
			const at = fileOf(info, request);

			return { "response": { "statements": engine === undefined || at.sourceFile === undefined ? null : engine.statementsOf(ts, at.program.getTypeChecker(), at.sourceFile) }, "responseRequired": true };
		});
	}

	/** A request's file (`arguments.file`): its path as the server names it, and the program and SourceFile of the project
	 *  that has it. */
	function fileOf(info, request) {
		const file = request && request.arguments && typeof request.arguments.file === "string" ? request.arguments.file : "";
		const path = ts.server !== undefined && typeof ts.server.toNormalizedPath === "function" ? ts.server.toNormalizedPath(file) : file;
		const project = info.project.projectService.getDefaultProjectForFile(path, false) || info.project;
		const program = project.getLanguageService().getProgram();

		return { "path": path, "program": program, "sourceFile": program === undefined ? undefined : program.getSourceFile(path) };
	}

	return {
		"create": function(info) {
			applyConfig(info.config);
			registerRequests(info);

			return info.languageService;
		},
		"onConfigurationChanged": function(config) { applyConfig(config); }
	};
}
