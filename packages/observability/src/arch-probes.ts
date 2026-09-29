/**
 * Generic probes for the architecture plane — the channels a context has that its hub doesn't carry: HTTP, raw
 * WebSockets and IndexedDB. Work in a window or any worker scope (including a service worker). Install them early,
 * before the context starts talking, and only once per realm.
 *
 * Hub traffic riding one of these (debug-mcp's WebSocket link) is skipped: the hub tap already counts it.
 */
import type { ArchSink, TrafficKind } from "./arch.ts";
import { approxSize } from "./arch.ts";

export interface NetworkProbeOptions {
	/** Node id of the endpoint a URL belongs to. Default: `net:origin` for this origin, `net:<host>` otherwise. */
	"classifyUrl"?: (url: URL) => string;
	/** Node id of the context that opened a WebSocket (default: `sink.self`) — e.g. an extension host sharing the realm. */
	"socketOwner"?: (url: URL) => string;
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
						sink.record(local, remote, described.kind, described.label, frameSize(data));
					} else {
						sink.record(remote, local, described.kind, described.label, frameSize(data));
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

function installIndexedDBProbe(sink: ArchSink): void {
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
				sink.record(sink.self, "idb", "request", this.transaction.db.name + " › " + this.name + "." + operation, operation === "put" || operation === "add" ? approxSize(args[0], 3) : 0);
			} catch { /* diagnostics only */ }

			return original.apply(this, args);
		};
	}
}

const installed = new WeakSet<object>();

/** Observe this realm's HTTP, WebSocket and IndexedDB traffic. Idempotent per realm. */
export function installNetworkProbes(sink: ArchSink, options: NetworkProbeOptions = {}): void {
	if (installed.has(globalThis)) {
		return;
	}

	installed.add(globalThis);

	const classify = options.classifyUrl ?? defaultClassify;

	installFetchProbe(sink, classify);
	installWebSocketProbe(sink, classify, options.socketOwner ?? (() => sink.self));
	installIndexedDBProbe(sink);
}
