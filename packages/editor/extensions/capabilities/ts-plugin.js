/**
 * Capabilities TypeScript Server Plugin: the capability findings, answered from the trees the in-browser tsserver already
 * holds, with its own `ts` and checker. It only answers requests (through `typescript.tsserverRequest`); what it computes
 * is the engine's (engine.ts, over lib's util/silo), and the extension shows it.
 *
 * `_capabilities.findings`: a file's capability findings (engine.findings), the static half (every call with a literal
 * resource, typed by the checker) merged with the canary's observations. The canary (canary.ts, tsval) runs the module in
 * the background, bounded by a tsval step budget, for the resources the static half can't see; while it runs, the answer
 * says `pending`, and the extension asks again. The canary needs `typescript`, so it's built with ts EXTERNAL and handed
 * tsserver's own via `globalThis.__capabilitiesTs`.
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

	function fileOf(info, request) {
		const file = request && request.arguments && typeof request.arguments.file === "string" ? request.arguments.file : "";
		const path = ts.server !== undefined && typeof ts.server.toNormalizedPath === "function" ? ts.server.toNormalizedPath(file) : file;
		const project = info.project.projectService.getDefaultProjectForFile(path, false) || info.project;
		const program = project.getLanguageService().getProgram();

		return { "path": path, "program": program, "sourceFile": program === undefined ? undefined : program.getSourceFile(path) };
	}

	let registered = false;

	function registerRequests(info) {
		if (registered || info.session === undefined || typeof info.session.addProtocolHandler !== "function") {
			return;
		}

		registered = true;

		// `_capabilities.findings`: a file's capability findings, for the extension to show (findings.ts).
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
	}

	return {
		"create": function(info) {
			applyConfig(info.config);
			registerRequests(info);

			return info.languageService;
		},
		"onConfigurationChanged": applyConfig
	};
}
