/**
 * The program's module system (packages/tsval/README.md, *Modules*): almostnode on the shared workspace, its built-ins
 * the capability stand-ins, and the editor's own modules a program imports as its code (node:test).
 */
import type { ModuleLoader } from "@brianjenkins94/tsval";
import type { Control } from "../debug-protocol";
import { REFS_DIR } from "@brianjenkins94/editor-api/git";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import nodeTestSource from "../node-test.js?raw";
import { tally } from "./gate";
import { installPackage } from "./install";
import { packageBuiltin, packageFetch, packageOf, packagesRan } from "./package-calls";
import { listening } from "./process";
import { noteProgramFile } from "./session";
import { post, state } from "./state";

export type Runtime = InstanceType<typeof import("@brianjenkins94/almostnode").Runtime>;

/** The runtime, loaded once per worker: the shared workspace (the launch's — the pod holds it) attached, its servers
 *  answering the preview. */
export function runtimeReady(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	return state.runtime === undefined ? loadRuntime(workspace) : Promise.resolve(state.runtime);
}

/** Load the runtime (runtimeReady): the first time a run asks for it. */
async function loadRuntime(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	const [{ createFsShim, createRunGlobal, getServerBridge, observeSockets, "packageDirOf": dirOf, webSocketGlobal }, { answerServer, programGlobals, serverOn, workspaceRuntime }, zenfs, { RuntimeVfs }] = await Promise.all([import("@brianjenkins94/almostnode"), import("../../../shared/workspace-runtime"), import("../../../shared/zenfs-vfs.js"), import("@brianjenkins94/editor-api/runtime-vfs")]);

	// (its files answered once the editor has the worker's mailbox — without it, the runtime's own)
	if (state.editorLink !== undefined) {
		const link = state.editorLink;

		await link.ready.then(() => {
			state.programFsFor = (cwd) => createFsShim(new RuntimeVfs(link.fs), () => cwd);
		}, () => undefined);
	}

	if (workspace !== undefined) {
		zenfs.attachSharedWorkspace(workspace);
	}

	state.packageDirOf = dirOf;

	const write = (method: string, path: string): never => {
		throw Object.assign(new Error(`EACCES: a library can't write in a debug run (${method} ${path})`), { "code": "EACCES" });
	};

	state.runGlobal = createRunGlobal();
	// A WebSocket the run opens to a server of its own (ws's, on a port) is joined to it here, as Node's reaches a server
	// on its own machine — and seen as that server's traffic, each frame and its close (the runtime link's `socket`).
	state.runGlobal.global.WebSocket = webSocketGlobal(globalThis.WebSocket);
	const socketsSeen = state.editorLink;

	observeSockets(socketsSeen === undefined ? undefined : ({ port, path }) => socketsSeen.socket(port, path));

	// (a commit opened beside the work, `.refs/` — the bridge's git-refs.ts — isn't in the workspace's store: its files,
	// a test's modules among them, are the editor's, through the link, as a program's own file calls are)
	const store = await zenfs.createZenfsVFS();
	const refs = state.editorLink === undefined ? undefined : new RuntimeVfs(state.editorLink.fs) as unknown as Record<string | symbol, unknown>;
	const atRefs = (path: unknown): boolean => typeof path === "string" && path.startsWith(`/workspace/${REFS_DIR}/`);
	const vfs = refs === undefined ? store : new Proxy(store, {
		"get": (target, property, receiver) => {
			const value = Reflect.get(target, property, receiver) as unknown;
			const there = refs[property];

			if (typeof value !== "function" || typeof there !== "function") {
				return value;
			}

			return (...args: unknown[]) => (atRefs(args[0]) ? (there as (...parameters: unknown[]) => unknown).apply(refs, args) : (value as (...parameters: unknown[]) => unknown).apply(target, args));
		}
	});

	state.runtime = workspaceRuntime(vfs, {
		"global": state.runGlobal,
		// (A program's own allowed write is let through while it's made: madeFor.)
		"beforeFs": (op, method, path) => {
			if (op === "write" && state.allowingWrites === 0) {
				write(method, path);
			}
		},
		// A package the policy bans (an org's contract: one known to be bad) doesn't run at all: its first module fails to
		// load, and the run's effects say so.
		"onPackage": (ran) => {
			packagesRan.set(ran.dir, ran);

			if (state.policy !== undefined && packageDisposition(state.policy, ran) === "deny") {
				tally("load", packageOf(ran.dir), "denied", packageOf(ran.dir), "policy");

				throw Object.assign(new Error(`EACCES: ${packageOf(ran.dir)} may not run — the policy bans it`), { "code": "EACCES" });
			}
		},
		// A package nothing in node_modules has (the editor serves packages from a CDN; type acquisition writes only their
		// types): installed in this worker's memory, at the version the editor pins.
		"install": (name) => installPackage(name),
		// The program's code gets its stand-ins (`fs`, `child_process`); a package, almostnode's own — its calls counted as its.
		"builtinFor": (id, requester, from) => {
			if (requester === "package") {
				return packageBuiltin(id, from);
			}

			return Object.hasOwn(state.programBuiltins, id) ? state.programBuiltins[id] : undefined;
		},
		// …and its own `fetch`, its calls counted as its (the program's `fetch` is its stand-in, as its built-ins are).
		"globalFor": (_name, requester, from) => (requester === "package" ? packageFetch(from) : undefined),
		// A program file a package requires: tsval's to evaluate, on the run's machine (a nested run).
		"evaluateProgram": (module, _require, source) => {
			if (state.evaluating === undefined) {
				throw new Error(`no run to evaluate ${module.filename} on`);
			}

			noteProgramFile(module.filename, () => source);
			state.evaluating.evaluateModule(module);
		}
	});
	// A server the program starts: answering the preview for its port, the request its handler's call (not stepped on the
	// main stack — a breakpoint in it pauses there, as in any host-invoked handler: onBreakpointHook).
	getServerBridge({ "onServerReady": (port: number) => {
		if (listening.has(port)) {
			return;
		}

		listening.add(port);
		// (the runtime link records each request and its answer as this server's traffic)
		state.editorLink?.serve(port, async (request) => {
			const server = serverOn(port);

			if (server === undefined) {
				return { "status": 502, "statusText": "Bad Gateway", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`nothing listens on ${port} any more`) };
			}

			// As the program's server answers it: the preview's taps are put in by the dev-server worker, as for any
			// debugger's server.
			return answerServer(server, request);
		});
		post({ "type": "listening", "port": port });
	} });

	state.nodeGlobals = programGlobals(state.runtime);

	return state.runtime;
}

/** The runtime as tsval's module loader (VMOptions.modules): it resolves; tsval evaluates the program's files; what isn't
 *  the program's, almostnode loads — asked for by the program, so its built-ins are the stand-ins. */
/** Where `node:test` is served from (node-test.js): a program file in no folder of the workspace's, so tsval runs it
 *  as the program's code — a test's awaits on the run's event loop — and nothing tells it as one of the program's files
 *  (its coverage, values and evidence aren't the program's). */
const NODE_TEST = "/__editor__/node-test.js";

/** The editor's modules a program imports as its own code, by the specifier it imports, and their sources. */
const EDITOR_MODULES = new Map([["node:test", NODE_TEST]]);

export const EDITOR_SOURCES = new Map([[NODE_TEST, nodeTestSource]]);

export function programModules(loaded: Runtime): ModuleLoader {
	const vfs = loaded.getVFS();

	return {
		// (`node:test` is node-test.js, run as the program's own code: EDITOR_MODULES)
		"resolve": (specifier, fromDir) => (EDITOR_MODULES.has(specifier) ? { "kind": "program", "filename": EDITOR_MODULES.get(specifier) } : loaded.resolve(specifier, fromDir)),
		"require": (specifier, fromDir) => loaded.require(specifier, fromDir, "program"),
		"source": (filename) => EDITOR_SOURCES.get(filename) ?? vfs.readFileSync(filename, "utf8"),
		"cached": (filename) => loaded.cached(filename),
		"register": (filename, module) => {
			// Another of the program's files, about to run: its capability stops armed first.
			if (!EDITOR_SOURCES.has(filename)) {
				noteProgramFile(filename, () => vfs.readFileSync(filename, "utf8"));
			}

			loaded.register(filename, module as Parameters<Runtime["register"]>[1]);
		},
		"forget": (filename) => { loaded.forget(filename); }
	};
}

/** Where a launch's program runs: its directory and environment, as the launch gives them. */
export function whereOf(message: Extract<Control, { "type": "launch" }>): { "cwd"?: string; "env"?: Record<string, string> } {
	return { ...message.cwd === undefined ? {} : { "cwd": message.cwd }, ...message.env === undefined ? {} : { "env": message.env } };
}
