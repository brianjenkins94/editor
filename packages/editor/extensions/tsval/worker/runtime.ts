import type { PlaywrightCall } from "@brianjenkins94/editor-api/runtime";
import type { Fetched, Outcome } from "@brianjenkins94/playwright";
import type { ModuleLoader } from "@brianjenkins94/tsval";
import type { Control } from "../debug-protocol";
import { REFS_DIR } from "@brianjenkins94/editor-api/git";
import { expect as playwrightExpect, Page } from "@brianjenkins94/playwright";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import nodeTestSource from "../node-test.js?raw";
import playwrightTestSource from "../playwright-test.js?raw";
import { DEVTOOLS_PORT, devtoolsJson, devtoolsSession } from "./devtools";
import { tally } from "./gate";
import { installPackage } from "./install";
import { packageBuiltin, packageFetch, packageOf, packagesRan } from "./package-calls";
import { listening } from "./process";
import { noteProgramFile } from "./session";
import { post, state } from "./state";

export type Runtime = InstanceType<typeof import("@brianjenkins94/almostnode").Runtime>;

export function runtimeReady(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	return state.runtime === undefined ? loadRuntime(workspace) : Promise.resolve(state.runtime);
}

async function loadRuntime(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	const [{ createFsShim, createRunGlobal, getServerBridge, observeSockets, "packageDirOf": dirOf, runEval, VirtualFS, webSocketGlobal }, { answerServer, programGlobals, serverOn, workspaceRuntime }, zenfs, { asVirtualFS, RuntimeVfs }] = await Promise.all([import("@brianjenkins94/almostnode"), import("../../../shared/workspace-runtime"), import("../../../shared/zenfs-vfs.js"), import("@brianjenkins94/editor-api/runtime-vfs")]);

	if (state.editorLink !== undefined) {
		const link = state.editorLink;

		await link.ready.then(() => {
			state.programFsFor = (cwd) => createFsShim(asVirtualFS(new RuntimeVfs(state.runLayer ?? link.fs, state.runtime?.getVFS()), VirtualFS), () => cwd);
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
	state.runEval = runEval(state.runGlobal, () => state.evaluating?.rootScope.globalObject);
	state.runGlobal.global.WebSocket = webSocketGlobal(globalThis.WebSocket);
	const socketsSeen = state.editorLink;

	observeSockets(socketsSeen === undefined ? undefined : ({ port, path }) => socketsSeen.socket(port, path));

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
		"beforeFs": (op, method, path) => {
			if (op === "write" && state.allowingWrites === 0) {
				write(method, path);
			}
		},
		"onPackage": (ran) => {
			packagesRan.set(ran.dir, ran);

			if (state.policy !== undefined && packageDisposition(state.policy, ran) === "deny") {
				tally("load", packageOf(ran.dir), "denied", packageOf(ran.dir), "policy");

				throw Object.assign(new Error(`EACCES: ${packageOf(ran.dir)} may not run — the policy bans it`), { "code": "EACCES" });
			}
		},
		"install": (name) => installPackage(name),
		"builtinFor": (id, requester, from) => {
			if (requester === "package") {
				return packageBuiltin(id, from);
			}

			return Object.hasOwn(state.programBuiltins, id) ? state.programBuiltins[id] : undefined;
		},
		"globalFor": (_name, requester, from) => (requester === "package" ? packageFetch(from) : undefined),
		"evaluateProgram": (module, _require, source) => {
			if (state.evaluating === undefined) {
				throw new Error(`no run to evaluate ${module.filename} on`);
			}

			noteProgramFile(module.filename, () => source);
			state.evaluating.evaluateModule(module);
		}
	});
	getServerBridge({ "onServerReady": (port: number) => {
		if (listening.has(port) || state.live || port === DEVTOOLS_PORT) {
			return;
		}

		listening.add(port);
		state.editorLink?.serve(port, async (request) => {
			const server = serverOn(port);

			if (server === undefined) {
				return { "status": 502, "statusText": "Bad Gateway", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`nothing listens on ${port} any more`) };
			}

			return answerServer(server, request);
		});
		post({ "type": "listening", "port": port });
	} });

	state.local = {
		"listening": (port) => serverOn(port) !== undefined,
		"answer": async (request) => answerServer(serverOn(request.port)!, request)
	};
	state.nodeGlobals = programGlobals(state.runtime);
	serveDevtools(state.runtime);

	return state.runtime;
}

interface DevtoolsSocket { "send": (data: string) => void; "on": (event: "message", listener: (data: unknown) => void) => void }

function serveDevtools(runtime: Runtime): void {
	const http = runtime.require("http", "/", "package") as typeof import("node:http");
	const { WebSocketServer } = runtime.require("ws", "/", "package") as { "WebSocketServer": new (options: { "server": unknown }) => { "on": (event: "connection", listener: (socket: DevtoolsSocket) => void) => void } };
	const realms = async (): Promise<Awaited<ReturnType<NonNullable<typeof state.editorLink>["realms"]>>> => state.editorLink?.realms();
	const server = http.createServer((request, response) => {
		void realms().then((reading) => {
			const json = devtoolsJson((request.url ?? "/").split("?")[0] ?? "/", reading, navigator.userAgent);

			response.writeHead(json === undefined ? 404 : 200, { "content-type": "application/json" });
			response.end(json === undefined ? "" : JSON.stringify(json));
		});
	});
	const sockets = new WebSocketServer({ "server": server });

	sockets.on("connection", (socket) => {
		const handle = devtoolsSession(realms, (message) => { socket.send(JSON.stringify(message)); });

		socket.on("message", (data) => { void handle(String(data)); });
	});
	server.listen(DEVTOOLS_PORT, "127.0.0.1");
	server.unref();
}

const NODE_TEST = "/__editor__/node-test.js";

const PLAYWRIGHT_TEST = "/__editor__/playwright-test.js";

const EDITOR_MODULES = new Map([["node:test", NODE_TEST], ["@playwright/test", PLAYWRIGHT_TEST]]);

export const EDITOR_SOURCES = new Map([[NODE_TEST, nodeTestSource], [PLAYWRIGHT_TEST, playwrightTestSource]]);

const pageIds = new WeakMap<Page, string>();
const playwrightCall = async (id: string, name: PlaywrightCall["call"], ...args: unknown[]): Promise<unknown> => {
	if (state.editorLink === undefined) {
		throw new Error("no editor to drive a preview in");
	}

	return state.editorLink.playwright({ "page": id, "call": name, "args": args });
};

export const editorPlaywright = {
	"page": () => {
		const id = crypto.randomUUID();
		const page = new Page({
			"run": async (op) => playwrightCall(id, "run", op) as Promise<Outcome>,
			"goto": async (url) => {
				tally("page:goto", url, "made");
				await playwrightCall(id, "goto", url);
			},
			"url": async () => playwrightCall(id, "url") as Promise<string>,
			"title": async () => playwrightCall(id, "title") as Promise<string>,
			"fetch": async (url, init) => {
				tally("page:request", url, "made");

				return playwrightCall(id, "fetch", url, init) as Promise<Fetched>;
			}
		});

		pageIds.set(page, id);

		return page;
	},
	"release": async (page: Page, kept: boolean) => {
		const id = pageIds.get(page);

		if (id !== undefined) {
			const { reach } = (await playwrightCall(id, "release", kept) ?? {}) as { "reach"?: Record<string, [number, number][]> };

			for (const [file, lines] of Object.entries(reach ?? {})) {
				state.windowReach.push({ "file": file, "statements": lines.map(([from, to]): [[number, number], [number, number]] => [[from, 0], [to, 0]]) });
			}
		}
	},
	"expect": playwrightExpect
};

export function programModules(loaded: Runtime): ModuleLoader {
	const vfs = loaded.getVFS();

	return {
		"resolve": (specifier, fromDir) => (EDITOR_MODULES.has(specifier) ? { "kind": "program", "filename": EDITOR_MODULES.get(specifier) } : loaded.resolve(specifier, fromDir)),
		"require": (specifier, fromDir) => loaded.require(specifier, fromDir, "program"),
		"imported": (specifier, fromDir) => loaded.imported(specifier, fromDir, "program"),
		"source": (filename) => EDITOR_SOURCES.get(filename) ?? vfs.readFileSync(filename, "utf8"),
		"cached": (filename) => loaded.cached(filename),
		"register": (filename, module) => {
			if (!EDITOR_SOURCES.has(filename)) {
				noteProgramFile(filename, () => vfs.readFileSync(filename, "utf8"));
			}

			loaded.register(filename, module as Parameters<Runtime["register"]>[1]);
		},
		"forget": (filename) => { loaded.forget(filename); }
	};
}

export function whereOf(message: Extract<Control, { "type": "launch" }>): { "cwd"?: string; "env"?: Record<string, string> } {
	return { ...message.cwd === undefined ? {} : { "cwd": message.cwd }, ...message.env === undefined ? {} : { "env": message.env } };
}
