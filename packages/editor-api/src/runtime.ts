/**
 * The workspace runtime, as a debugger reaches it (packages/editor/ARCHITECTURE.md, *Extension points* 2): the workspace's own files, read and written
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
import type { MetricsReporter, Observed, ObserveOptions } from "@brianjenkins94/observability";
import type { Effect } from "./index.ts";
import { createHub, createRpcClient, portTransport, rpcCallSubject, rpcReplySubject, serve } from "@brianjenkins94/hub";
import { observe, relayLoggerToHub, reportMetrics } from "@brianjenkins94/observability";
import { NETWORK_PROBES } from "./probes.ts";

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
 *  link runtime ports share (the bridge's host and the workbench).
 *  (The key keeps the package's old name, run-contract: it's how a published copy and core find each other, so it never changes.) */
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

/** A request the preview makes of a server the program listens with, on `port`. `entry`: a worker's entry script. Its
 *  body is whole, or — under `exchanges`, for a request sent in pieces — a stream, read as the server reads it. */
export interface RuntimeRequest { "port": number; "method": string; "url": string; "headers": Record<string, string>; "body"?: Uint8Array | ReadableStream<Uint8Array>; "entry"?: "worker" | "sharedworker" }

/** The server's answer: its body whole, or a stream of it as the server writes it (passed on in pieces by `exchanges`). */
export interface RuntimeResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> | ReadableStream<Uint8Array> }

/**
 * An exchange as it travels — every call on the preview's route (the service worker → a tab's root → the dev-server worker
 * → a run's `virtual.debug.<port>`), each carrying its port so every hop sends it the same way as the request.
 *
 * A request may name its exchange (`stream`) so that either body can come in pieces: with `more`, its body follows in
 * `write` calls (the last with `end`), each answered once the server has room for it; and the answer, its `stream` set,
 * is only the start of its body — the rest is `read`, a piece at a time, each answered with what's arrived since the
 * last (after a wait, maybe nothing), until `done`. A `cancel` drops the exchange, as a client hanging up. One the caller
 * leaves alone for a minute is dropped too. A request without `stream` is answered whole, as before.
 */
export type ExchangeCall = WireRequest | ExchangeStep;
/** A request as it travels: its body whole, or (`more`) to follow. */
export type WireRequest = Omit<RuntimeRequest, "body"> & { "body"?: Uint8Array; "stream"?: string; "more"?: true };
/** The rest of an exchange: a piece of the request's body (`write`, `end`), the next of the answer's (`read`), or `cancel`. */
export interface ExchangeStep { "port": number; "stream": string; "write"?: Uint8Array; "end"?: true; "read"?: true; "cancel"?: true }
/** An answer as it travels: whole, or the start of its body with `stream` set. `listening` false: nobody serves the port. */
export interface WireResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number>; "stream"?: string; "listening"?: false }
/** A `read`'s answer. */
export interface ExchangePiece { "body": Uint8Array; "done": boolean }

/** How long a `read` with nothing to give waits before answering empty — under every hop's timeout. */
const READ_WAIT_MS = 15_000;
/** How long an exchange nobody touches is kept. */
const IDLE_MS = 60_000;
/** The most a piece gathers before it's sent. */
const PIECE_BYTES = 1024 * 1024;
/** How much of a request's body is queued ahead of the server before a `write` waits. */
const REQUEST_QUEUE_BYTES = 65_536;

interface Exchange {
	/** The request's body, fed by `write`s. */
	"feed": ReadableStreamDefaultController<Uint8Array>;
	"body": ReadableStream<Uint8Array>;
	/** A `write` waiting for room. */
	"room"?: () => void;
	/** The answer's body. */
	"reader"?: ReadableStreamDefaultReader<Uint8Array>;
	/** A read of it under way, kept for the next `read` when it wasn't answered in time. */
	"pending"?: Promise<ReadableStreamReadResult<Uint8Array>>;
	"idle"?: ReturnType<typeof setTimeout>;
}

function joinPieces(pieces: Uint8Array[]): Uint8Array {
	const joined = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
	let at = 0;

	for (const piece of pieces) {
		joined.set(piece, at);
		at += piece.byteLength;
	}

	return joined;
}

/** All of `stream`. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const pieces: Uint8Array[] = [];

	for (const reader = stream.getReader(); ;) {
		const { done, value } = await reader.read();

		if (done) {
			return joinPieces(pieces);
		}

		pieces.push(value);
	}
}

/**
 * Answer the calls of streamed exchanges with `handler`, which gets each request with its body whole or a stream, and
 * answers with its body whole or a stream. What it returns answers every `ExchangeCall` for one server (or several:
 * exchanges are told apart by their id).
 */
export function exchanges(handler: (request: RuntimeRequest) => Promise<RuntimeResponse>): (call: ExchangeCall) => Promise<WireResponse | ExchangePiece | { "ok": boolean }> {
	const open = new Map<string, Exchange>();
	/** Exchanges ended — kept a while, so a `write` still on its way isn't taken for the start of a new one. */
	const ended = new Set<string>();

	function end(id: string): void {
		open.delete(id);
		ended.add(id);
		setTimeout(() => { ended.delete(id); }, IDLE_MS);
	}

	/** The exchange `id` — made by whichever of its calls comes first (its first `write` may overtake the request). */
	function exchange(id: string): Exchange {
		let found = open.get(id);

		if (found === undefined) {
			let feed!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				"start": (controller) => { feed = controller; },
				"pull": () => {
					found!.room?.();
					found!.room = undefined;
				}
			}, { "highWaterMark": REQUEST_QUEUE_BYTES, "size": (chunk) => chunk.byteLength });

			found = { "feed": feed, "body": body };
			open.set(id, found);
		}

		clearTimeout(found.idle);
		found.idle = setTimeout(() => { drop(id); }, IDLE_MS);

		return found;
	}

	function drop(id: string): void {
		const gone = open.get(id);

		if (gone === undefined) {
			return;
		}

		end(id);
		clearTimeout(gone.idle);
		gone.room?.();

		try {
			gone.feed.error(new Error("the exchange was dropped"));
		} catch {
			// (already closed)
		}

		void gone.reader?.cancel().catch(() => undefined);
	}

	/** What's arrived of the answer's body: waiting up to `waitMs` for its first piece, then taking whatever else is
	 *  already there (up to PIECE_BYTES). */
	async function gather(id: string, found: Exchange, waitMs: number): Promise<ExchangePiece> {
		const pieces: Uint8Array[] = [];
		let bytes = 0;

		for (let wait = waitMs; bytes < PIECE_BYTES; wait = 0) {
			const reading = found.pending ?? found.reader!.read();
			const timedOut = Symbol("timed out");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const read = await Promise.race([reading, new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => { resolve(timedOut); }, wait); })]);

			clearTimeout(timer);

			if (read === timedOut) {
				found.pending = reading;

				return { "body": joinPieces(pieces), "done": false };
			}

			found.pending = undefined;

			if (read.done) {
				end(id);
				clearTimeout(found.idle);

				return { "body": joinPieces(pieces), "done": true };
			}

			pieces.push(read.value);
			bytes += read.value.byteLength;
		}

		return { "body": joinPieces(pieces), "done": false };
	}

	return async (call) => {
		if (!("method" in call)) {
			const step = call;
			const found = open.get(step.stream);

			if (step.cancel === true) {
				drop(step.stream);

				return { "ok": true };
			}

			if (step.read === true) {
				return found?.reader === undefined ? { "body": new Uint8Array(), "done": true } : gather(step.stream, exchange(step.stream), READ_WAIT_MS);
			}

			if (ended.has(step.stream)) {
				return { "ok": false };
			}

			const writing = exchange(step.stream);

			try {
				if (step.write !== undefined) {
					writing.feed.enqueue(step.write);

					if ((writing.feed.desiredSize ?? 0) <= 0) {
						await new Promise<void>((resolve) => { writing.room = resolve; });
					}
				}

				if (step.end === true) {
					writing.feed.close();
				}
			} catch {
				return { "ok": false }; // (its body was closed under it: the exchange is over)
			}

			return { "ok": open.has(step.stream) };
		}

		const { stream, more, ...request } = call;
		const streamed = stream === undefined ? undefined : exchange(stream);
		const response = await handler({ ...request, "body": more === true && streamed !== undefined ? streamed.body : request.body });
		const head = { "status": response.status, "statusText": response.statusText, "headers": response.headers };

		if (!(response.body instanceof ReadableStream)) {
			if (stream !== undefined) {
				drop(stream);
			}

			return { ...head, "body": response.body };
		}

		if (streamed === undefined) {
			return { ...head, "body": await drain(response.body) };
		}

		streamed.reader = response.body.getReader();

		// The answer starts with what's already written — often all of it.
		const first = await gather(stream!, streamed, 0);

		return first.done ? { ...head, "body": first.body } : { ...head, "body": first.body, "stream": stream };
	};
}

/** `name`@`version`'s published tarball: a lockfile's `resolved`, else npm's registry's — what a run installs a package
 *  from (the editor fetches it: `RuntimeConnection.tarball`) and the capabilities baseline reads it from. */
export const tarballUrl = (name: string, version: string, resolved?: string): string => resolved ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;

/** Where core puts the workspace runtime in an extension host (the bridge's, in the bridge's; core's bootstrap's, in
 *  the web worker host).
 *  (The key keeps the package's old name, run-contract: it's how a published copy and core find each other, so it never changes.) */
const RUNTIME = Symbol.for("@brianjenkins94/run-contract/workspaceRuntime");

/** The workspace runtime of this extension host — undefined outside the editor. */
export function workspaceRuntime(): WorkspaceRuntime | undefined {
	return (globalThis as { [RUNTIME]?: WorkspaceRuntime })[RUNTIME];
}

/** An extension on the editor's observability plane (`observeExtension`): its log, its metrics, and its leaving. */
export interface ObservedExtension {
	/** Its records, on `$sys.log` — where the editor's own are, and debug-mcp's `logs_query` reads them. */
	"log": Observed["log"];
	/** Its gauges, sampled to `$sys.metrics` (the editor's metrics plane: `editor.metrics.read`, the insights monitor). */
	"metrics": MetricsReporter;
	"dispose": () => void;
}

/**
 * The extension `name` on the editor's hub, for observability alone — any extension, a contributed one too: its logs
 * and metrics ride the hub as `ext:<name>`'s, through the workspace runtime's link (the way a debugger's worker joins,
 * packages/editor/ARCHITECTURE.md, *Extension points* 2), which carries them and nothing of the editor's services. Not its console: the extension host is
 * every extension's, so what an extension logs is what it hands `log`. Undefined outside the editor.
 */
export function observeExtension(name: string): ObservedExtension | undefined {
	const runtime = workspaceRuntime();

	if (runtime === undefined) {
		return undefined;
	}

	const id = `ext:${name}`;
	const { port, dispose } = runtime.connect(id);
	const hub = createHub({ "id": id });
	const unlink = hub.link(portTransport(port), { "uplink": true });
	const metrics = reportMetrics(hub);

	return {
		"log": relayLoggerToHub(hub, hub.id),
		"metrics": metrics,
		"dispose": () => {
			metrics.dispose();
			unlink();
			dispose();
		}
	};
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

/**
 * Why a package's call is asked about — what the baseline said of it, so whoever is asked knows: the capability `grew`
 * (`by` the code's use of the package — `origin` the members it started using, `*` all of it — or a new `version`,
 * `origin` that version); the analysis didn't predict it (`unpredicted`: none of what was read of the package reaches
 * it); the baseline read `other-version` (`recorded`) than the one running; it has nothing of the package (`unread`);
 * or there's no baseline (`no-baseline`).
 */
export type AskedWhy =
	| { "reason": "grew"; "by": "code" | "version"; "origin": string }
	| { "reason": "unpredicted" }
	| { "reason": "other-version"; "recorded": string }
	| { "reason": "unread" }
	| { "reason": "no-baseline" };

/** A package's gated call, for the editor to decide at the call: its kind (an fs call's method and whether it reads or
 *  writes; a command; a request), its arguments as strings, the package, by name@version, and why it's asked about. */
export interface RuntimeDecision { "kind": "fs" | "exec" | "net"; "method"?: string; "op"?: "read" | "write"; "args": string[]; "package": string; "why"?: AskedWhy }

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
	/** `name`@`version`'s published tarball (gzipped), fetched by the editor — for a package nothing in node_modules has,
	 *  to install in the worker's own memory (the workspace's filesystem is too small for node_modules). Blocks until it's
	 *  fetched (once `ready`); fails as a read does (`ENOENT`, …) when it can't be. */
	"tarball": (name: string, version: string) => Uint8Array;
	/** Answer the preview's requests to `port` with `handler` until the returned disposer runs — each body whole, or a
	 *  stream (see `exchanges`). */
	"serve": (port: number, handler: (request: RuntimeRequest) => Promise<RuntimeResponse>) => () => void;
	/** The worker's logger: its records and spans are the editor's, as this worker's. */
	"log": Observed["log"];
}

/** Connect a debugger's worker to the editor's runtime through `port` (`WorkspaceRuntime.connect(name, session)`'s), as
 *  `name` — what the editor knows it by. `network`: probes for the worker's own requests, as observability's `observe`
 *  takes them — by default the editor's (./probes), so the architecture view names what the worker reaches as it names
 *  the editor's own. */
export function connectRuntime(port: MessagePort, { name, network = NETWORK_PROBES }: { "name": string; "network"?: ObserveOptions["network"] }): RuntimeConnection {
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
		"tarball": (name, version) => call({ "op": "tarball", "name": name, "version": version }).payload,
		"log": log,
		"serve": (listening, handler) => {
			const answer = exchanges(async (request) => {
				const path = request.url.split("?")[0];

				// Each server's traffic, as its own: the architecture view's `server:<port>`.
				architecture.record(architecture.self, `server:${listening}`, "request", `${request.method} ${path}`, request.body instanceof ReadableStream ? 0 : request.body?.byteLength ?? 0);

				const response = await handler(request);

				architecture.record(`server:${listening}`, architecture.self, response.status >= 400 ? "error" : "reply", `${response.status} ${path}`, response.body instanceof ReadableStream ? 0 : response.body.length);

				return response;
			});

			return serve(hub, `virtual.debug.${listening}`, async (raw) => answer(raw as ExchangeCall));
		}
	};
}

// The mailbox (packages/editor/ARCHITECTURE.md, *Extension points* 2, *The runtime's files*): a worker's calls to the editor, one at a time — the worker
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
