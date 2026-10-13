/**
 * The workspace runtime, as a debugger reaches it (EXTENSION-POINTS.md, 2): the workspace's own files, read and written
 * synchronously as a program's `require` and `readFileSync` need them, and the preview's requests to a server the
 * program starts. Any debugger may have it — tsval's, and an interpreter plugged in as `run.debugger`.
 *
 * - The extension asks for it with `workspaceRuntime()` — a `WorkspaceRuntime`, wherever its extension host is (core
 *   puts it in each), or undefined outside the editor. `connect(name, session)` gives a port into the editor's runtime,
 *   for the debugger's worker: `name` what the editor knows it by (each worker of that name one instance of it),
 *   `session` the id of the debug session it runs — bound to the link, so the worker (and the program in it) can't run
 *   under another. `buffer` is the workspace itself (zen-fs's SingleBuffer) — given only to the editor's own debugger,
 *   built with the same zen-fs; anyone else's reads and writes go through `fs`.
 * - The worker connects with `connectRuntime(port, { "name": … })`. Its `fs` reads and writes the workspace
 *   synchronously, each call answered by the editor: an open editor's unsaved text, a write as the workspace's, and a
 *   call of the program's decided by the session's policy, as the editor decides every run's, and kept among the run's
 *   effects by the editor itself (a `{ load: true }` call is the debugger's own: the program and what it imports). A
 *   server its program listens with answers the preview through `serve(port, request => response)`. Its log, its spans
 *   and each server's traffic are the editor's to see, as its own (debug-mcp, the architecture view).
 *
 * The extension's own code never joins the editor's hub: only its worker's runtime link does, through this.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Observed, ObserveOptions } from "@brianjenkins94/observability";
import type { Effect } from "./index.ts";
import { createHub, createRpcClient, portTransport, rpcCallSubject, rpcReplySubject, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";

/** What `workspaceRuntime()` gives a debugger's extension. */
export interface WorkspaceRuntime {
	/** The workspace, for the editor's own debugger to mount at /workspace — absent for anyone else's, and without
	 *  cross-origin isolation. */
	readonly "buffer": SharedArrayBuffer | undefined;
	/** A port into the editor's runtime, for one worker known as `name`, running debug session `session` (transfer it
	 *  there, and `connectRuntime` it as the same name); `dispose` when the worker's gone. */
	"connect": (name: string, session?: string) => { "port": MessagePort; "dispose": () => void };
}

/** Where core keeps each runtime link's session, by the id it gave the worker — in core's realm, which both ends that
 *  link runtime ports share (the bridge's host and the workbench). */
const LINKS = Symbol.for("@brianjenkins94/run-contract/runtimeLinks");

function links(): Map<string, string | undefined> {
	const realm = globalThis as { [LINKS]?: Map<string, string | undefined> };

	realm[LINKS] ??= new Map();

	return realm[LINKS];
}

/** Core: the debug session the runtime link the editor named `id` was made for — undefined when none was named. */
export function runtimeSession(id: string): string | undefined {
	return links().get(id);
}

/** Core: link a debugger's worker's port into `hub` — the one way every runtime link is made, whichever extension host
 *  the worker's debugger is in. The editor names the worker `<name>#<instance>` (its own, so an answer goes to it alone;
 *  the architecture view counts each as an instance of `name`), bound to `session` (runtimeSession), and the link carries
 *  only the runtime: the worker's log, architecture and metrics, its mailbox handed over, its servers' requests and
 *  their answers — no other service of the editor's. */
export function linkRuntime(hub: Hub, port: MessagePort, name: string, session?: string): () => void {
	const id = `${name}#${crypto.randomUUID().slice(0, 8)}`;

	links().set(id, session);

	const unlink = hub.link(portTransport(port), { "peer": id,
"permissions": {
		"publish": ["$sys.log.>", "$sys.backlog.log", "$sys.arch.>", "$sys.metrics.>", "bridge.ready", rpcCallSubject("runtime.fs.attach"), rpcReplySubject("node")],
		"subscribe": ["$sys.arch.sync", rpcCallSubject("virtual.debug.*"), rpcReplySubject(id)]
	} });

	return () => {
		unlink();
		links().delete(id);
	};
}

/** A request the preview makes of a server the program listens with, on `port`. `entry`: a worker's entry script. */
export interface RuntimeRequest { "port": number; "method": string; "url": string; "headers": Record<string, string>; "body"?: Uint8Array; "entry"?: "worker" | "sharedworker" }

/** The server's answer. */
export interface RuntimeResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> }

/** Where core puts the workspace runtime in an extension host (the bridge's, in the bridge's; core's bootstrap's, in
 *  the web worker host). */
const RUNTIME = Symbol.for("@brianjenkins94/run-contract/workspaceRuntime");

/** The workspace runtime of this extension host — undefined outside the editor. */
export function workspaceRuntime(): WorkspaceRuntime | undefined {
	return (globalThis as { [RUNTIME]?: WorkspaceRuntime })[RUNTIME];
}

/** Core: the workspace runtime of this extension host is `runtime`. */
export function provideWorkspaceRuntime(runtime: WorkspaceRuntime): void {
	(globalThis as { [RUNTIME]?: WorkspaceRuntime })[RUNTIME] = runtime;
}

/** A file or folder, as `fs.stat` tells it. */
export interface RuntimeStat { "type": "file" | "directory"; "size": number; "mtime": number }

/** The workspace's files, synchronously, each call answered by the editor. A call is the program's — decided by the
 *  session's policy, and kept among the run's effects — unless `load` says it's the debugger's own (reads only). Failures
 *  are node's: an `Error` with its `code` (`ENOENT`, `EACCES`, …). Paths are absolute, under `/workspace`. */
export interface RuntimeFs {
	"readFile": (path: string, options?: { "load"?: boolean }) => Uint8Array;
	"writeFile": (path: string, data: Uint8Array | string) => void;
	/** Undefined when there's nothing there. */
	"stat": (path: string, options?: { "load"?: boolean }) => RuntimeStat | undefined;
	"readdir": (path: string, options?: { "load"?: boolean }) => string[];
	/** With its parents. */
	"mkdir": (path: string) => void;
	/** With what's in it. */
	"rm": (path: string) => void;
	/** In place of what's at `to`. */
	"rename": (path: string, to: string) => void;
}

/** A package's gated call, for the editor to decide at the call: its kind (an fs call's method and whether it reads or
 *  writes; a command; a request), its arguments as strings, and the package, by name@version. */
export interface RuntimeDecision { "kind": "fs" | "exec" | "net"; "method"?: string; "op"?: "read" | "write"; "args": string[]; "package": string }

/** What the editor decided: whether the call may be made, and how (an Effect's `decided`). */
export interface RuntimeVerdict { "allow": boolean; "decided": NonNullable<Effect["decided"]> }

/** A worker's link into the editor's runtime. */
export interface RuntimeConnection {
	/** The workspace's files (once `ready`). */
	"fs": RuntimeFs;
	/** `fs` answered from here on: the editor has the worker's mailbox. */
	"ready": Promise<void>;
	/** A package's call beyond its baseline, decided by the editor at the call — redline, the policy, then the person,
	 *  asked — blocking until it's answered (once `ready`). */
	"decide": (call: RuntimeDecision) => RuntimeVerdict;
	/** Answer the preview's requests to `port` with `handler` until the returned disposer runs. */
	"serve": (port: number, handler: (request: RuntimeRequest) => Promise<RuntimeResponse>) => () => void;
	/** The worker's logger: its records and spans are the editor's, as this worker's. */
	"log": Observed["log"];
}

/** Connect a debugger's worker to the editor's runtime through `port` (`WorkspaceRuntime.connect(name, session)`'s), as
 *  `name` — what the editor knows it by. `network`: probes for the worker's own requests, as observability's `observe`
 *  takes them. */
export function connectRuntime(port: MessagePort, { name, network = false }: { "name": string; "network"?: ObserveOptions["network"] }): RuntimeConnection {
	const hub = createHub({ "id": name });

	// (up, to the editor: the id it knows the worker by is the worker's — its calls are answered there)
	const link = hub.link(portTransport(port), { "uplink": true });

	const { log, architecture } = observe(hub, { "network": network });

	// (a membership line in the bridge's log, once it's listening)
	void hub.whenInterested("bridge.ready", 30_000).then((wanted) => {
		if (wanted) {
			hub.publish("bridge.ready", { "worker": hub.id });
		}
	});

	const mailbox = createMailbox();
	let attached = false;
	// (once the editor has said who the worker is: a call made before goes out under the name its answer isn't sent to)
	const ready = link.ready.then(async () => createRpcClient(hub).request("runtime.fs.attach", { "mailbox": mailbox }, { "timeoutMs": 30_000, "waitForResponderMs": 30_000 })).then(() => { attached = true; });
	const call = (meta: Record<string, unknown>, payload?: Uint8Array): Decoded => {
		if (!attached) {
			throw Object.assign(new Error("the workspace runtime isn't connected yet: await its `ready`"), { "code": "ENOTCONN" });
		}

		const answer = askMailbox(mailbox, meta, payload);

		if (answer.failed) {
			const { message, code } = answer.meta as { "message"?: string; "code"?: string };

			throw Object.assign(new Error(message ?? "failed"), { "code": code ?? "EIO" });
		}

		return answer;
	};

	return {
		"fs": {
			"readFile": (path, options) => call({ "op": "readFile", "path": path, "load": options?.load === true }).payload,
			"writeFile": (path, data) => { call({ "op": "writeFile", "path": path }, typeof data === "string" ? new TextEncoder().encode(data) : data); },
			"stat": (path, options) => (call({ "op": "stat", "path": path, "load": options?.load === true }).meta as { "stat"?: RuntimeStat }).stat,
			"readdir": (path, options) => (call({ "op": "readdir", "path": path, "load": options?.load === true }).meta as { "entries": string[] }).entries,
			"mkdir": (path) => { call({ "op": "mkdir", "path": path }); },
			"rm": (path) => { call({ "op": "rm", "path": path }); },
			"rename": (path, to) => { call({ "op": "rename", "path": path, "to": to }); }
		},
		"ready": ready,
		"decide": (decision) => call({ "op": "decide", "call": decision }).meta as RuntimeVerdict,
		"log": log,
		"serve": (listening, handler) => serve(hub, `virtual.debug.${listening}`, async (raw) => {
			const request = raw as RuntimeRequest;
			const path = request.url.split("?")[0];

			// Each server's traffic, as its own: the architecture view's `server:<port>`.
			architecture.record(architecture.self, `server:${listening}`, "request", `${request.method} ${path}`, request.body?.byteLength ?? 0);

			const response = await handler(request);

			architecture.record(`server:${listening}`, architecture.self, response.status >= 400 ? "error" : "reply", `${response.status} ${path}`, response.body.length);

			return response;
		})
	};
}

// The mailbox (EXTENSION-POINTS.md, 2, *The runtime's files*): a worker's calls to the editor, one at a time — the worker
// writes a request and waits on it (Atomics.wait), the editor watches it (Atomics.waitAsync), answers, and wakes it. A
// header of four Int32s, then the data; what doesn't fit goes in pieces, each acknowledged.

const STATE = 0;
/** Bytes of the piece in the data. */
const LENGTH = 1;
/** 1: more pieces follow this one. */
const MORE = 2;
/** 1: the answer is a failure. */
const FAILED = 3;
/** The worker's turn (to write, or read an answer). */
const IDLE = 0;
/** The editor's turn: a piece of a request (or, while an answer is in pieces, an empty one asking for the next). */
const ASKED = 1;
/** The worker's turn: a piece of the answer (or, while a request is in pieces, an empty one acknowledging it). */
const ANSWERED = 2;
const HEADER_BYTES = 16;

/** An answer: its meta, its bytes, and whether it's a failure (the meta then its `message` and `code`). */
export interface Decoded { "meta": unknown; "payload": Uint8Array; "failed": boolean }

/** A mailbox, with `bytes` of room for a piece. */
export function createMailbox(bytes = 1024 * 1024): SharedArrayBuffer {
	return new SharedArrayBuffer(HEADER_BYTES + bytes);
}

/** A message: its JSON's length (4 bytes), its JSON, then its bytes. */
function encode(meta: unknown, payload?: Uint8Array): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(meta));
	const message = new Uint8Array(4 + json.length + (payload?.length ?? 0));

	new DataView(message.buffer).setUint32(0, json.length);
	message.set(json, 4);
	message.set(payload ?? new Uint8Array(), 4 + json.length);

	return message;
}

function decode(message: Uint8Array, failed = false): Decoded {
	const length = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0);

	return { "meta": JSON.parse(new TextDecoder().decode(message.subarray(4, 4 + length))), "payload": message.subarray(4 + length), "failed": failed };
}

function joined(pieces: Uint8Array[]): Uint8Array {
	const whole = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
	let at = 0;

	for (const piece of pieces) {
		whole.set(piece, at);
		at += piece.length;
	}

	return whole;
}

/** The worker's side: ask `meta` (and `payload`), and wait for the answer. */
export function askMailbox(mailbox: SharedArrayBuffer, meta: unknown, payload?: Uint8Array): Decoded {
	const message = encode(meta, payload);
	const header = new Int32Array(mailbox, 0, 4);
	const data = new Uint8Array(mailbox, HEADER_BYTES);
	const ask = (): void => {
		Atomics.store(header, STATE, ASKED);
		Atomics.notify(header, STATE);
		Atomics.wait(header, STATE, ASKED);
	};

	for (let at = 0; ; at += data.length) {
		const piece = message.subarray(at, at + data.length);
		const last = at + data.length >= message.length;

		data.set(piece);
		header[LENGTH] = piece.length;
		header[MORE] = last ? 0 : 1;
		ask();

		if (last) {
			break;
		}
	}

	const pieces: Uint8Array[] = [];

	for (;;) {
		// (a copy: TextDecoder doesn't read shared memory)
		pieces.push(data.slice(0, header[LENGTH]));

		if (header[MORE] === 0) {
			break;
		}

		header[LENGTH] = 0;
		ask();
	}

	const failed = header[FAILED] === 1;

	Atomics.store(header, STATE, IDLE);

	return decode(joined(pieces), failed);
}

/** The editor's side: answer the calls written into `mailbox` with `answer` (a failure: thrown, with its `code`), until
 *  the returned function runs. */
export function answerMailbox(mailbox: SharedArrayBuffer, answer: (meta: Record<string, unknown>, payload: Uint8Array) => Promise<{ "meta": Record<string, unknown>; "payload"?: Uint8Array }>): () => void {
	const header = new Int32Array(mailbox, 0, 4);
	const data = new Uint8Array(mailbox, HEADER_BYTES);
	const stopped = new AbortController();

	void (async () => {
		let incoming: Uint8Array[] = [];
		let outgoing: Uint8Array | undefined;
		let sent = 0;
		const reply = (): void => {
			const piece = outgoing!.subarray(sent, sent + data.length);

			data.set(piece);
			sent += piece.length;
			header[LENGTH] = piece.length;
			header[MORE] = sent < outgoing!.length ? 1 : 0;

			if (header[MORE] === 0) {
				outgoing = undefined;
			}

			Atomics.store(header, STATE, ANSWERED);
			Atomics.notify(header, STATE);
		};

		while (!stopped.signal.aborted) {
			const state = Atomics.load(header, STATE);

			if (state !== ASKED) {
				// (a while at most, to notice being stopped)
				const waited = Atomics.waitAsync(header, STATE, state, 30_000);

				if (waited.async) {
					await waited.value;
				}

				continue;
			}

			if (outgoing !== undefined) {
				reply(); // the next piece of the answer, asked for
				continue;
			}

			incoming.push(data.slice(0, header[LENGTH]));

			if (header[MORE] === 1) {
				header[LENGTH] = 0;
				header[MORE] = 0;
				Atomics.store(header, STATE, ANSWERED);
				Atomics.notify(header, STATE);
				continue;
			}

			const request = decode(joined(incoming));

			incoming = [];

			try {
				const { meta, payload } = await answer(request.meta as Record<string, unknown>, request.payload);

				header[FAILED] = 0;
				outgoing = encode(meta, payload);
			} catch (error) {
				header[FAILED] = 1;
				outgoing = encode({ "message": error instanceof Error ? error.message : String(error), "code": (error as { "code"?: unknown }).code ?? "EIO" });
			}

			sent = 0;
			reply();
		}
	})();

	return () => { stopped.abort(); };
}
