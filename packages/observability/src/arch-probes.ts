/**
 * Generic probes for the architecture plane — the channels a context has that its hub doesn't carry: HTTP (fetch
 * and XMLHttpRequest, sync included), raw WebSockets, IndexedDB, BroadcastChannels, Web Locks and WebRTC peer
 * connections (their signaling, state and data channels); plus, opt-in, the workers a realm spawns and the window
 * messages it receives. Message-carrying probes hand the sink each payload too, kept only while capture is on. Work in a window or any worker scope (including a service worker). Install them early,
 * before the context starts talking, and only once per realm. Generic on purpose: a channel nobody modelled still
 * shows up (and is flagged), which is how the diagram discovers what it wasn't told about.
 *
 * Hub traffic riding one of these (debug-mcp's WebSocket link) is skipped: the hub tap already counts it — unless
 * `hubFrames: "record"`, for a realm observed by probes alone (no hub tap: an app the observer knows nothing about).
 */
import type { ArchSink, TrafficKind } from "./arch.ts";
import { approxSize, normalizeSubject } from "./arch.ts";

export interface ProbeOptions {
	/** Hub frames: "skip" (default — the hub tap counts them) or "record" like any other message (probes alone). */
	"hubFrames"?: "skip" | "record";
}

export interface NetworkProbeOptions extends ProbeOptions {
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

/** Fields that name a message, when it has no JSON-RPC / DAP / `type` shape — the usual ones, whatever the protocol. */
const NAME_FIELDS = ["subject", "topic", "event", "channel"];

/**
 * A message's kind and label, from what it says it is: JSON-RPC, DAP, a `type` — else the usual naming fields (a
 * `subject`, `topic`, `event` or `channel`; ids folded, as in subjects). A one-key wrapper (`{ "\0hub": frame }`,
 * `{ "payload": … }`) is described by what it wraps. Knows no protocol in particular: it's how the diagram names the
 * messages of an app it was told nothing about.
 */
export function describeJsonMessage(message: unknown, depth = 0): { "kind": TrafficKind; "label": string } {
	if (typeof message !== "object" || message === null) {
		return { "kind": "message", "label": typeof message };
	}

	const record = message as Record<string, unknown>;
	const keys = Object.keys(record);

	if (keys.length === 1 && depth < 3) {
		const inner = record[keys[0]!];

		if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
			return describeJsonMessage(inner, depth + 1);
		}
	}

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

	const name = NAME_FIELDS.map((field) => record[field]).find((value) => typeof value === "string" && value !== "");

	return { "kind": "message", "label": typeof name === "string" ? normalizeSubject(name) : "message" };
}

/** A same-origin window's name, from what the platform says of it: what the page embedding it calls its frame (the
 *  `<iframe>`'s `title`, `name` or `id`), else its URL — path and query, id-like query values folded (`match=*`). One
 *  we can't read (cross-origin) is `window:cross-origin`. The same for a window naming itself and for the windows that
 *  message it, so both ends agree. */
export function windowName(target: Window): string {
	try {
		const frame = target.frameElement;
		const given = frame?.getAttribute("title") || frame?.getAttribute("name") || frame?.id;

		if (typeof given === "string" && given !== "") {
			return "window:" + given;
		}

		const url = new URL(target.location.href);
		const query = [...url.searchParams].map(([key, value]) => key + "=" + (normalizeSubject(value) === "*" ? "*" : value)).join("&");

		return "window:" + (url.protocol === "about:" ? url.href : url.pathname) + (query === "" ? "" : "?" + query);
	} catch {
		return "window:cross-origin";
	}
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

/** Whether a probe passes over this message (see ProbeOptions.hubFrames). */
function skipper({ hubFrames = "skip" }: ProbeOptions): (data: unknown) => boolean {
	return hubFrames === "record" ? () => false : isHubFrame;
}

function installWebSocketProbe(sink: ArchSink, classify: (url: URL) => string, owner: (url: URL) => string, skip: (data: unknown) => boolean): void {
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
					if (skip(data)) {
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
	const skip = skipper(options);

	installWebSocketProbe(sink, classify, options.socketOwner ?? (() => sink.self), skip);
	installIndexedDBProbe(sink, options.idbOwner ?? (() => undefined));
	installBroadcastChannelProbe(sink, skip);
	installLocksProbe(sink);
	installRtcProbe(sink, skip);
}

/** A message's kind and label (describeJsonMessage), from an object or its JSON text. */
function describeAny(data: unknown): { "kind": TrafficKind; "label": string } {
	if (typeof data === "string") {
		try {
			return describeJsonMessage(JSON.parse(data));
		} catch {
			return { "kind": "message", "label": "text" };
		}
	}

	return describeJsonMessage(data);
}

/** BroadcastChannels: each name a node (`channel:<name>`, ids folded to `*`), its messages to and from it — once one
 *  that isn't a hub frame crosses (a hub link over a channel is counted by the hub tap; its medium isn't news). */
function installBroadcastChannelProbe(sink: ArchSink, skip: (data: unknown) => boolean): void {
	const Original = globalThis.BroadcastChannel as typeof BroadcastChannel | undefined;

	if (Original === undefined) {
		return;
	}

	const seen = new Set<string>();
	const record = (id: string, name: string, outgoing: boolean, data: unknown): void => {
		if (skip(data)) {
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

/**
 * WebRTC, in two parts — both media: two realms on one are drawn as the edge between them (ArchitectureStore).
 * - Each peer connection a node, `rtc:<its first data channel's label>` (else `rtc:<n>`), so both ends of a connection
 *   name it alike: its signaling (offers, answers, candidates — their payloads are the SDP) and its states, as the realm
 *   managing it records them. An answering end learns the label only when the channel arrives: what it signaled before
 *   then is recorded under it then.
 * - Each data channel a node, `datachannel:<label>`, and its messages, wherever it's used: RTCDataChannel's prototype
 *   is hooked, so a channel handed to a worker as it's created (there's no RTCPeerConnection in a worker) is seen there.
 */
function installRtcProbe(sink: ArchSink, skip: (data: unknown) => boolean): void {
	installDataChannelProbe(sink, skip);

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

				const n = count;
				let id: string | undefined;
				const pending: ((named: string) => void)[] = [];
				// Named by its first data channel — or, with none after a while, by its number.
				const name = (label?: string): void => {
					if (id !== undefined) {
						return;
					}

					clearTimeout(fallback);
					id = "rtc:" + (label === undefined || label === "" ? String(n) : normalizeSubject(label));
					sink.spawn({ "id": id, "label": "Peer connection " + (label ?? n), "role": "peer connection", "dynamic": true, "detail": "RTCPeerConnection" });

					for (const record of pending.splice(0)) {
						record(id);
					}
				};
				const fallback = setTimeout(name, 5000);
				const record = (write: (named: string) => void): void => {
					if (id === undefined) {
						pending.push(write);
					} else {
						write(id);
					}
				};
				const state = (what: string, value: string): void => { record((named) => { sink.record(sink.self, named, "lifecycle", what + ": " + value); }); };

				(fallback as { "unref"?: () => void }).unref?.();
				connection.addEventListener("signalingstatechange", () => { state("signaling", connection.signalingState); });
				connection.addEventListener("iceconnectionstatechange", () => { state("ice", connection.iceConnectionState); });
				connection.addEventListener("connectionstatechange", () => {
					state("connection", connection.connectionState);

					if (connection.connectionState === "closed" || connection.connectionState === "failed") {
						record((named) => { sink.terminate(named); });
					}
				});
				connection.addEventListener("icecandidate", (event) => {
					if (event.candidate !== null) {
						const { candidate } = event;

						record((named) => { sink.record(sink.self, named, "event", "local candidate", approxSize(candidate.candidate), 1, candidate.toJSON()); });
					}
				});
				connection.addEventListener("datachannel", (event) => { name(event.channel.label); });

				// The signaling steps, with what they carry (an offer's or answer's SDP, a remote candidate).
				const methods = connection as unknown as Record<string, (...rest: unknown[]) => unknown>;

				for (const method of ["createOffer", "createAnswer", "setLocalDescription", "setRemoteDescription", "addIceCandidate"]) {
					const original = methods[method]!.bind(connection);

					methods[method] = (...rest: unknown[]) => {
						const description = rest[0] as { "type"?: string } | undefined;
						const result = original(...rest);

						record((named) => { sink.record(sink.self, named, "request", method + (typeof description?.type === "string" ? " (" + description.type + ")" : ""), approxSize(rest[0]), 1, rest[0]); });

						return result;
					};
				}

				const createDataChannel = connection.createDataChannel.bind(connection);

				connection.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
					const channel = createDataChannel(label, init);

					name(label);

					return channel;
				};
			} catch { /* never break the connection */ }

			return connection;
		}
	});
}

/** Data channels, by their prototype (see installRtcProbe): what's sent, and — once the app listens — what arrives. */
function installDataChannelProbe(sink: ArchSink, skip: (data: unknown) => boolean): void {
	const Channel = globalThis.RTCDataChannel as typeof RTCDataChannel | undefined;

	if (Channel === undefined) {
		return;
	}

	const prototype = Channel.prototype as unknown as Record<string, unknown> & RTCDataChannel;
	const seen = new Set<string>();
	const watched = new WeakSet<object>();
	const add = prototype.addEventListener as (this: RTCDataChannel, type: string, ...rest: unknown[]) => void;
	const record = (channel: RTCDataChannel, outgoing: boolean, data: unknown): void => {
		if (skip(data)) {
			return;
		}

		const id = "datachannel:" + normalizeSubject(channel.label || "data");

		if (!seen.has(id)) {
			seen.add(id);
			sink.spawn({ "id": id, "label": channel.label || "data", "role": "data channel", "dynamic": true, "detail": "RTCDataChannel" });
		}

		const { kind, label } = typeof data === "string" ? describeAny(data) : { "kind": "message" as const, "label": "binary" };

		if (outgoing) {
			sink.record(sink.self, id, kind, label, frameSize(data), 1, data);
		} else {
			sink.record(id, sink.self, kind, label, frameSize(data), 1, data);
		}
	};
	const watch = (channel: RTCDataChannel): void => {
		if (!watched.has(channel)) {
			watched.add(channel);
			add.call(channel, "message", (event: MessageEvent) => {
				try {
					record(channel, false, event.data);
				} catch { /* diagnostics only */ }
			});
		}
	};
	const send = prototype.send as (this: RTCDataChannel, data: unknown) => void;

	prototype.send = function(this: RTCDataChannel, data: unknown) {
		try {
			record(this, true, data);
		} catch { /* diagnostics only */ }

		send.call(this, data);
	} as RTCDataChannel["send"];
	prototype.addEventListener = function(this: RTCDataChannel, type: string, ...rest: unknown[]) {
		if (type === "message") {
			watch(this);
		}

		add.call(this, type, ...rest);
	} as RTCDataChannel["addEventListener"];

	const onmessage = Object.getOwnPropertyDescriptor(Channel.prototype, "onmessage");

	if (onmessage?.set !== undefined) {
		Object.defineProperty(Channel.prototype, "onmessage", {
			...onmessage,
			"set": function(this: RTCDataChannel, handler: unknown) {
				watch(this);
				onmessage.set!.call(this, handler);
			}
		});
	}
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
export function installWorkerProbe(sink: ArchSink, identify: (url: string, options?: WorkerOptions) => WorkerIdentity | undefined = () => undefined, options: ProbeOptions = {}): void {
	if (typeof globalThis.Worker !== "function") {
		return;
	}

	const skip = skipper(options);

	globalThis.Worker = new Proxy(globalThis.Worker, {
		"construct": function(target, args: [string | URL, WorkerOptions?], newTarget) {
			const worker = Reflect.construct(target, args, newTarget) as Worker;

			try {
				const url = String(args[0]);
				// By its name when it has one (often the id its own hub goes by), else its script.
				const identity = identify(url, args[1]) ?? { "id": args[1]?.name || "worker:" + (url.split(/[?#]/u)[0]!.split("/").pop() ?? "worker") };
				const record = (outgoing: boolean, data: unknown): void => {
					if (skip(data)) {
						return;
					}

					const { kind, label } = describeAny(data);

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
 * preview iframe by its port); an unnamed one is named by windowName (its frame's title, else its URL), so an
 * unexpected iframe still shows up.
 */
export function installWindowMessageProbe(sink: ArchSink, identify: (source: Window) => string | undefined = () => undefined, options: ProbeOptions = {}): void {
	if (typeof window === "undefined") {
		return;
	}

	const skip = skipper(options);

	window.addEventListener("message", (event: MessageEvent) => {
		const { data, source } = event;

		if (source === null || source === window || !("postMessage" in source) || skip(data) || (typeof data === "object" && data !== null && "\0paneLink" in data)) {
			return;
		}

		const { kind, label } = describeAny(data);
		const from = identify(source as Window) ?? windowName(source as Window);

		sink.record(from, sink.self, kind, event.ports.length > 0 ? label + " (+MessagePort)" : label, approxSize(data), 1, data);
	}, true);
}
