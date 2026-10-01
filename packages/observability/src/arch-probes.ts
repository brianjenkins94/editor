/**
 * Generic probes for the architecture plane — the channels a context has that its hub doesn't carry: HTTP (fetch
 * and XMLHttpRequest, sync included), raw WebSockets, IndexedDB, BroadcastChannels, Web Locks and WebRTC peer
 * connections (their signaling, state and data channels); plus, opt-in, the workers a realm spawns and the window
 * messages it receives. Message-carrying probes hand the sink each payload too, kept only while capture is on. Work in a window or any worker scope (including a service worker). Install them early,
 * before the context starts talking, and only once per realm. Generic on purpose: a channel nobody modelled still
 * shows up (and is flagged), which is how the diagram discovers what it wasn't told about.
 *
 * Hub traffic riding one of these (debug-mcp's WebSocket link) is skipped: the hub tap already counts it.
 */
import type { ArchSink, TrafficKind } from "./arch.ts";
import { approxSize, normalizeSubject } from "./arch.ts";

export interface NetworkProbeOptions {
	/** Node id of the endpoint a URL belongs to. Default: `net:origin` for this origin, `net:<host>` otherwise. */
	"classifyUrl"?: (url: URL) => string;
	/** Node id of the context that opened a WebSocket (default: `sink.self`) — e.g. an extension host sharing the realm. */
	"socketOwner"?: (url: URL) => string;
	/** Node id that OWNS an IndexedDB database (default: this realm) — e.g. a filesystem persisting through it. */
	"idbOwner"?: (database: string) => string | undefined;
}

const WIRE = "\0hub";

/** Is this a `@brianjenkins94/hub` wire frame (object, or its JSON text over a WebSocket)? */
export function isHubFrame(data: unknown): boolean {
	if (typeof data === "string") {
		return data.startsWith("{\"\\u0000hub\"");
	}

	return typeof data === "object" && data !== null && WIRE in data;
}

function defaultClassify(url: URL): string {
	return url.origin === globalThis.location?.origin ? "net:origin" : "net:" + url.host;
}

function shortPath(url: URL): string {
	const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

	return segments.length > 2 ? "…/" + segments.slice(-2).join("/") : url.pathname;
}

function frameSize(data: unknown): number {
	if (typeof data === "string") {
		return data.length;
	}

	if (typeof Blob !== "undefined" && data instanceof Blob) {
		return data.size;
	}

	return approxSize(data);
}

/** JSON-RPC / DAP message → kind + label, for sockets and workers speaking them. */
export function describeJsonMessage(message: unknown): { "kind": TrafficKind; "label": string } {
	if (typeof message !== "object" || message === null) {
		return { "kind": "message", "label": typeof message };
	}

	const record = message as Record<string, unknown>;

	if (typeof record["method"] === "string") {
		return { "kind": record["id"] === undefined ? "event" : "request", "label": record["method"] };
	}

	if (record["jsonrpc"] !== undefined && record["id"] !== undefined) {
		return { "kind": record["error"] === undefined ? "reply" : "error", "label": "↩ #" + String(record["id"]) };
	}

	if (record["type"] === "request" && typeof record["command"] === "string") {
		return { "kind": "request", "label": record["command"] };
	}

	if (record["type"] === "response" && typeof record["command"] === "string") {
		return { "kind": record["success"] === false ? "error" : "reply", "label": "↩ " + record["command"] };
	}

	if (record["type"] === "event" && typeof record["event"] === "string") {
		return { "kind": "event", "label": record["event"] };
	}

	if (typeof record["type"] === "string") {
		return { "kind": "message", "label": record["type"] };
	}

	return { "kind": "message", "label": "message" };
}

function installFetchProbe(sink: ArchSink, classify: (url: URL) => string): void {
	const nativeFetch = globalThis.fetch;

	if (typeof nativeFetch !== "function") {
		return;
	}

	globalThis.fetch = async function(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const raw = input instanceof Request ? input.url : String(input);

		if (raw.startsWith("data:") || raw.startsWith("blob:")) {
			return nativeFetch.call(this, input, init);
		}

		let url: URL;

		try {
			url = new URL(raw, globalThis.location?.href);
		} catch {
			return nativeFetch.call(this, input, init);
		}

		const target = classify(url);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");

		sink.record(sink.self, target, "request", method + " " + shortPath(url), approxSize(init?.body));

		try {
			const response = await nativeFetch.call(this, input, init);

			sink.record(target, sink.self, response.ok ? "reply" : "error", response.status + " " + shortPath(url), Number(response.headers.get("content-length") ?? 0));

			return response;
		} catch (error) {
			sink.record(target, sink.self, "error", "network error " + shortPath(url));

			throw error;
		}
	};
}

function installWebSocketProbe(sink: ArchSink, classify: (url: URL) => string, owner: (url: URL) => string): void {
	if (typeof globalThis.WebSocket !== "function") {
		return;
	}

	globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
		"construct": function(target, args: [string | URL, (string | string[])?], newTarget) {
			const socket = Reflect.construct(target, args, newTarget) as WebSocket;

			try {
				const url = new URL(String(args[0]), globalThis.location?.href);
				const remote = classify(url);
				const local = owner(url);
				const onFrame = (outgoing: boolean, data: unknown): void => {
					if (isHubFrame(data)) {
						return;
					}

					let described: { "kind": TrafficKind; "label": string } = { "kind": "message", "label": "frame" };

					if (typeof data === "string") {
						try {
							described = describeJsonMessage(JSON.parse(data));
						} catch { /* not JSON */ }
					}

					if (outgoing) {
						sink.record(local, remote, described.kind, described.label, frameSize(data), 1, data);
					} else {
						sink.record(remote, local, described.kind, described.label, frameSize(data), 1, data);
					}
				};

				socket.addEventListener("open", () => { sink.spawn({ "id": remote }); });
				socket.addEventListener("close", () => { sink.terminate(remote); });
				socket.addEventListener("message", (event) => { onFrame(false, event.data); });

				const send = socket.send.bind(socket);

				socket.send = (data) => {
					onFrame(true, data);
					send(data);
				};
			} catch { /* never break the socket */ }

			return socket;
		}
	});
}

function installIndexedDBProbe(sink: ArchSink, owner: (database: string) => string | undefined): void {
	if (typeof IDBObjectStore === "undefined") {
		return;
	}

	const operations = ["get", "getAll", "getAllKeys", "getKey", "count", "put", "add", "delete", "clear", "openCursor", "openKeyCursor"];
	const prototype = IDBObjectStore.prototype as unknown as Record<string, (this: IDBObjectStore, ...args: unknown[]) => unknown>;

	for (const operation of operations) {
		const original = prototype[operation];

		if (typeof original !== "function") {
			continue;
		}

		prototype[operation] = function(this: IDBObjectStore, ...args: unknown[]) {
			try {
				const database = this.transaction.db.name;

				sink.record(owner(database) ?? sink.self, "idb", "request", database + " › " + this.name + "." + operation, operation === "put" || operation === "add" ? approxSize(args[0], 3) : 0);
			} catch { /* diagnostics only */ }

			return original.apply(this, args);
		};
	}
}

const installed = new WeakSet();

/** Observe this realm's HTTP, WebSocket, IndexedDB, BroadcastChannel, Web Locks and WebRTC traffic. Idempotent per
 *  realm. */
export function installNetworkProbes(sink: ArchSink, options: NetworkProbeOptions = {}): void {
	if (installed.has(globalThis)) {
		return;
	}

	installed.add(globalThis);

	const classify = options.classifyUrl ?? defaultClassify;

	installFetchProbe(sink, classify);
	installXhrProbe(sink, classify);
	installWebSocketProbe(sink, classify, options.socketOwner ?? (() => sink.self));
	installIndexedDBProbe(sink, options.idbOwner ?? (() => undefined));
	installBroadcastChannelProbe(sink);
	installLocksProbe(sink);
	installRtcProbe(sink);
}

/** A message's kind and label: JSON-RPC / DAP / `{ type }` shapes, from an object or its JSON text. */
function describeAny(data: unknown): { "kind": TrafficKind; "label": string } {
	if (typeof data === "string") {
		try {
			return describeJsonMessage(JSON.parse(data));
		} catch {
			return { "kind": "message", "label": "text" };
		}
	}

	// A message's own kind first (`type`, JSON-RPC, DAP); a `channel` field only names one that has none.
	const described = describeJsonMessage(data);

	if (described.label === "message" && typeof data === "object" && data !== null && "channel" in data && typeof data.channel === "string") {
		return { "kind": "message", "label": data.channel };
	}

	return described;
}

/** BroadcastChannels: each name a node (`channel:<name>`, ids folded to `*`), its messages to and from it — once one
 *  that isn't a hub frame crosses (a hub link over a channel is counted by the hub tap; its medium isn't news). */
function installBroadcastChannelProbe(sink: ArchSink): void {
	const Original = globalThis.BroadcastChannel as typeof BroadcastChannel | undefined;

	if (Original === undefined) {
		return;
	}

	const seen = new Set<string>();
	const record = (id: string, name: string, outgoing: boolean, data: unknown): void => {
		if (isHubFrame(data)) {
			return;
		}

		if (!seen.has(id)) {
			seen.add(id);
			sink.spawn({ "id": id, "label": id.slice("channel:".length), "role": "channel", "dynamic": true, "detail": "BroadcastChannel" });
		}

		const { kind, label } = describeAny(data);

		if (outgoing) {
			sink.record(sink.self, id, kind, label, approxSize(data), 1, data);
		} else {
			sink.record(id, sink.self, kind, label, approxSize(data), 1, data);
		}
	};

	globalThis.BroadcastChannel = class extends Original {
		private readonly probeId: string;

		public constructor(name: string) {
			super(name);
			this.probeId = "channel:" + normalizeSubject(String(name));
			super.addEventListener("message", (event) => {
				try {
					record(this.probeId, this.name, false, (event as MessageEvent).data);
				} catch { /* diagnostics only */ }
			});
		}

		public override postMessage(message: unknown): void {
			try {
				record(this.probeId, this.name, true, message);
			} catch { /* diagnostics only */ }

			super.postMessage(message);
		}
	};
}

/** Web Locks: each lock a node (`lock:<name>`), asked for, granted (or unavailable) and released. */
function installLocksProbe(sink: ArchSink): void {
	const locks = (globalThis.navigator as { "locks"?: LockManager } | undefined)?.locks;

	if (locks === undefined || typeof locks.request !== "function") {
		return;
	}

	const seen = new Set<string>();
	const request = locks.request.bind(locks) as (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => Promise<unknown>;

	(locks as { "request": unknown }).request = (name: string, ...rest: unknown[]): Promise<unknown> => {
		const callback = rest.pop() as (lock: Lock | null) => unknown;
		const options = (rest[0] ?? {}) as LockOptions;
		const id = "lock:" + normalizeSubject(String(name));

		try {
			if (!seen.has(id)) {
				seen.add(id);
				sink.spawn({ "id": id, "label": id.slice("lock:".length), "role": "lock", "dynamic": true, "detail": "Web Lock" });
			}

			sink.record(sink.self, id, "request", "request (" + (options.mode ?? "exclusive") + (options.ifAvailable === true ? ", if available" : "") + ")");
		} catch { /* diagnostics only */ }

		return request(name, options, async (lock) => {
			try {
				sink.record(id, sink.self, lock === null ? "error" : "reply", lock === null ? "unavailable" : "granted");
			} catch { /* diagnostics only */ }

			try {
				return await callback(lock);
			} finally {
				if (lock !== null) {
					try {
						sink.record(sink.self, id, "lifecycle", "released");
					} catch { /* diagnostics only */ }
				}
			}
		});
	};
}

/** WebRTC: each peer connection a node (`rtc:<n>`) — its signaling (offers, answers, candidates: their payloads are
 *  the SDP), its states, and every data channel's messages, by channel label. */
function installRtcProbe(sink: ArchSink): void {
	const Original = globalThis.RTCPeerConnection as typeof RTCPeerConnection | undefined;

	if (Original === undefined) {
		return;
	}

	let count = 0;

	globalThis.RTCPeerConnection = new Proxy(Original, {
		"construct": function(target, args: [RTCConfiguration?], newTarget) {
			const connection = Reflect.construct(target, args, newTarget) as RTCPeerConnection;

			try {
				count += 1;

				const id = "rtc:" + count;
				const state = (what: string, value: string): void => { sink.record(sink.self, id, "lifecycle", what + ": " + value); };
				const watch = (channel: RTCDataChannel): void => {
					const name = channel.label || "data";
					const record = (outgoing: boolean, data: unknown): void => {
						if (isHubFrame(data)) {
							return;
						}

						const { kind, label } = typeof data === "string" ? describeAny(data) : { "kind": "message" as const, "label": "binary" };

						if (outgoing) {
							sink.record(sink.self, id, kind, name + ": " + label, frameSize(data), 1, data);
						} else {
							sink.record(id, sink.self, kind, name + ": " + label, frameSize(data), 1, data);
						}
					};

					channel.addEventListener("open", () => { state("channel " + name, "open"); });
					channel.addEventListener("close", () => { state("channel " + name, "closed"); });
					channel.addEventListener("message", (event) => { record(false, event.data); });

					const send = channel.send.bind(channel) as (data: unknown) => void;

					channel.send = (data: string & Blob & ArrayBuffer & ArrayBufferView<ArrayBuffer>) => {
						record(true, data);
						send(data);
					};
				};

				sink.spawn({ "id": id, "label": "Peer connection " + count, "role": "peer connection", "dynamic": true, "detail": "RTCPeerConnection" });
				connection.addEventListener("signalingstatechange", () => { state("signaling", connection.signalingState); });
				connection.addEventListener("iceconnectionstatechange", () => { state("ice", connection.iceConnectionState); });
				connection.addEventListener("connectionstatechange", () => {
					state("connection", connection.connectionState);

					if (connection.connectionState === "closed" || connection.connectionState === "failed") {
						sink.terminate(id);
					}
				});
				connection.addEventListener("icecandidate", (event) => {
					if (event.candidate !== null) {
						sink.record(sink.self, id, "event", "local candidate", approxSize(event.candidate.candidate), 1, event.candidate.toJSON());
					}
				});
				connection.addEventListener("datachannel", (event) => { watch(event.channel); });

				// The signaling steps, with what they carry (an offer's or answer's SDP, a remote candidate).
				const methods = connection as unknown as Record<string, (...rest: unknown[]) => unknown>;

				for (const method of ["createOffer", "createAnswer", "setLocalDescription", "setRemoteDescription", "addIceCandidate"]) {
					const original = methods[method]!.bind(connection);

					methods[method] = (...rest: unknown[]) => {
						const description = rest[0] as { "type"?: string } | undefined;
						const result = original(...rest);

						sink.record(sink.self, id, "request", method + (typeof description?.type === "string" ? " (" + description.type + ")" : ""), approxSize(rest[0]), 1, rest[0]);

						return result;
					};
				}

				const createDataChannel = connection.createDataChannel.bind(connection);

				connection.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
					const channel = createDataChannel(label, init);

					watch(channel);

					return channel;
				};
			} catch { /* never break the connection */ }

			return connection;
		}
	});
}

/** XMLHttpRequest, synchronous ones included (a worker asking the service worker for a capability decision). */
function installXhrProbe(sink: ArchSink, classify: (url: URL) => string): void {
	if (typeof XMLHttpRequest === "undefined") {
		return;
	}

	const targets = new WeakMap<XMLHttpRequest, { "target": string; "label": string }>();
	const { open, send } = XMLHttpRequest.prototype;

	XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
		try {
			const parsed = new URL(String(url), globalThis.location?.href);

			targets.set(this, { "target": classify(parsed), "label": method + " " + shortPath(parsed) });
		} catch { /* unparseable: not recorded */ }

		return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
	} as typeof XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
		const info = targets.get(this);

		if (info !== undefined) {
			sink.record(sink.self, info.target, "request", info.label + " (XHR)", approxSize(body));
			this.addEventListener("loadend", () => {
				sink.record(info.target, sink.self, this.status >= 200 && this.status < 400 ? "reply" : "error", this.status + " " + info.label, approxSize(this.response));
			});
		}

		send.call(this, body as XMLHttpRequestBodyInit | null);
	};
}

export interface WorkerIdentity {
	"id": string;
	"label"?: string;
	"container"?: string;
}

/**
 * Observe the workers this realm spawns (the workbench realm has its own, monaco-aware probe — use this elsewhere,
 * e.g. in a worker that spawns workers). Hub frames are left to the hub tap; the rest is described as JSON-RPC /
 * DAP / `{ type }` messages.
 */
export function installWorkerProbe(sink: ArchSink, identify: (url: string, options?: WorkerOptions) => WorkerIdentity | undefined = () => undefined): void {
	if (typeof globalThis.Worker !== "function") {
		return;
	}

	globalThis.Worker = new Proxy(globalThis.Worker, {
		"construct": function(target, args: [string | URL, WorkerOptions?], newTarget) {
			const worker = Reflect.construct(target, args, newTarget) as Worker;

			try {
				const url = String(args[0]);
				// By its name when it has one (often the id its own hub goes by), else its script.
				const identity = identify(url, args[1]) ?? { "id": args[1]?.name || "worker:" + (url.split(/[?#]/u)[0]!.split("/").pop() ?? "worker") };
				const record = (outgoing: boolean, data: unknown): void => {
					if (isHubFrame(data)) {
						return;
					}

					const { kind, label } = describeJsonMessage(data);

					if (outgoing) {
						sink.record(sink.self, identity.id, kind, label, approxSize(data), 1, data);
					} else {
						sink.record(identity.id, sink.self, kind, label, approxSize(data), 1, data);
					}
				};

				sink.spawn({ "id": identity.id, "label": identity.label, "container": identity.container, "role": "worker", "dynamic": true, "detail": "spawned by " + sink.self });

				const postMessage = worker.postMessage.bind(worker) as (message: unknown, transfer?: unknown) => void;

				worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void => {
					record(true, message);
					postMessage(message, transfer);
				};
				worker.addEventListener("message", (event) => { record(false, event.data); });

				const terminate = worker.terminate.bind(worker);

				worker.terminate = () => {
					sink.terminate(identity.id);
					terminate();
				};
			} catch { /* never break a worker */ }

			return worker;
		}
	});
}

/**
 * Observe the messages this window receives from OTHER windows (iframes, popups, its parent) — everything but hub
 * traffic (counted by the hub tap, including pane-link-wrapped frames). `identify` names the sending window (e.g. a
 * preview iframe by its port); an unnamed one becomes `window:<its path>`, so an unexpected iframe still shows up.
 */
export function installWindowMessageProbe(sink: ArchSink, identify: (source: Window) => string | undefined = () => undefined): void {
	if (typeof window === "undefined") {
		return;
	}

	const frameOf = (source: Window): string => {
		try {
			return "window:" + source.location.pathname;
		} catch {
			return "window:cross-origin";
		}
	};

	window.addEventListener("message", (event: MessageEvent) => {
		const { data, source } = event;

		if (source === null || source === window || !("postMessage" in source) || isHubFrame(data) || (typeof data === "object" && data !== null && "\0paneLink" in data)) {
			return;
		}

		const record = data as { "channel"?: unknown; "type"?: unknown } | null;
		// Its own kind (`type`) first; a `channel` field only names a message that has none.
		const name = typeof record?.type === "string" ? record.type : typeof record?.channel === "string" ? record.channel : typeof data;
		const from = identify(source as Window) ?? frameOf(source as Window);

		sink.record(from, sink.self, "message", event.ports.length > 0 ? name + " (+MessagePort)" : name, approxSize(data), 1, data);
	}, true);
}
