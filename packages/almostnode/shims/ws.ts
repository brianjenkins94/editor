/**
 * ws (WebSocket) shim for browser environment: a script's `require("ws")`.
 *
 * A `ws://localhost:<port>` URL whose port a WebSocketServer in this realm is bound to (`{ port }`, or `{ server }` once
 * that server listens) is that server, as Node reaches its own; any other `ws://` or `wss://` URL is a real server
 * somewhere: the browser's own WebSocket reaches it. Any other URL (`/socket`, `http://localhost:8080/socket`) is a
 * WebSocketServer in this same realm, listening on that path. A client and a server here are joined in memory, each
 * side's `send` arriving at the other — no channel between realms, so nothing leaks to another context (or another tab
 * of the origin) — and each connection is told to the realm's observer (observeSockets), its frames and its close, so a
 * socket the program keeps to itself is still seen.
 */

import EventEmitter from "events/events.js";

// Polyfill for CloseEvent (not available in Node.js)
const CloseEventPolyfill = typeof CloseEvent !== "undefined" ? CloseEvent : class CloseEvent extends Event {
	code: number;
	reason: string;
	wasClean: boolean;
	constructor(type: string, init?: { "code"?: number; "reason"?: string; "wasClean"?: boolean }) {
		super(type);
		this.code = init?.code ?? 1000;
		this.reason = init?.reason ?? "";
		this.wasClean = init?.wasClean ?? true;
	}
};

// Polyfill for MessageEvent (not available in Node.js)
const MessageEventPolyfill = typeof MessageEvent !== "undefined" ? MessageEvent : class MessageEvent extends Event {
	data: unknown;
	constructor(type: string, init?: { "data"?: unknown }) {
		super(type);
		this.data = init?.data;
	}
};

// The servers listening in this realm, by path.
const servers = new Map<string, WebSocketServer>();
/** The servers bound to a port in this realm, by port. */
const bound = new Map<number, WebSocketServer[]>();
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** A connection joined in this realm, as its observer hears it: each frame (`fromClient`: the client sent it) and its
 *  close, once. */
export interface SocketWatch {
	"frame": (fromClient: boolean, data: unknown) => void;
	"closed": (code: number, reason: string) => void;
}

/** What sees each connection joined in this realm: told as it opens — the client's URL, the server's port (when it's
 *  bound to one) and the path — it answers with what hears the rest. */
export type SocketObserver = (connection: { "url": string; "port": number | undefined; "path": string }) => SocketWatch | undefined;

let observer: SocketObserver | undefined;

/** Who sees this realm's connections from now on (undefined: no one). */
export function observeSockets(next: SocketObserver | undefined): void {
	observer = next;
}

/** The path a client's URL asks for: `/socket` of `/socket` or `http://localhost:8080/socket`. */
function pathOf(url: string): string {
	try {
		return new URL(url, "http://localhost").pathname;
	} catch {
		return url;
	}
}

/** The server in this realm a `ws://localhost:<port>/<path>` URL reaches: one bound to its port, on its path (or on
 *  none — a server with no `path` takes them all). */
function localServer(url: string): WebSocketServer | undefined {
	let parsed: URL;

	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}

	if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || !LOCAL_HOSTS.has(parsed.hostname)) {
		return undefined;
	}

	return bound.get(Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80)))?.find(({ options }) => options.path === undefined || options.path === parsed.pathname);
}

const keepAlive = (): { "retain": (handle: object) => void; "release": (handle: object) => void } | undefined => (globalThis as unknown as { "__nodeKeepAlive"?: { "retain": (handle: object) => void; "release": (handle: object) => void } }).__nodeKeepAlive;

export class WebSocket extends EventEmitter {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly CONNECTING = WebSocket.CONNECTING;
	readonly OPEN = WebSocket.OPEN;
	readonly CLOSING = WebSocket.CLOSING;
	readonly CLOSED = WebSocket.CLOSED;

	readyState: number = WebSocket.CONNECTING;
	url: string;
	protocol = "";
	extensions = "";
	bufferedAmount = 0;
	binaryType: "blob" | "arraybuffer" = "blob";

	private _server: WebSocketServer | null = null;
	private _nativeWs: globalThis.WebSocket | null = null;
	/** The other end, for a connection made in this realm: what this side sends, it receives. */
	private _peer: WebSocket | null = null;
	/** Its connection's observer (both ends share it) and whether this end is the client: what it sends is told as sent
	 *  from there. */
	private _watched: { "watch": SocketWatch; "closed": boolean } | undefined;
	private _isClient = false;
	/** EventTarget-style listeners (addEventListener), as `ws`'s sockets have them: each its handler on the emitter. */
	private readonly _listeners = new Map<string, Map<unknown, (...args: unknown[]) => void>>();

  // Event handler properties
	onopen: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(url: string, protocols?: string | string[]) {
		super();
		this.url = url;

		if (protocols) {
			this.protocol = Array.isArray(protocols) ? protocols[0] : protocols;
		}

    // Connect asynchronously
		setTimeout(() => { this._connect(); }, 0);
	}

	private _connect(): void {
    // For internal WebSocket connections (from server to client), connect immediately
		if (this.url.startsWith("internal://")) {
			this.readyState = WebSocket.OPEN;
			this.emit("open");
			if (this.onopen) { this.onopen(new Event("open")); }

			return;
		}

		// A server in this realm bound to the URL's port: joined to it here.
		const local = localServer(this.url);

		if (local !== undefined) {
			this._join(local);

			return;
		}

    // For external WebSocket connections, use the browser's native WebSocket.
    // This allows libraries like the Convex CLI (which require('ws')) to
    // communicate with real remote servers.
		if (this.url.startsWith("ws://") || this.url.startsWith("wss://")) {
			this._connectNative();

			return;
		}

    // Any other URL: a server in this realm, listening on its path — or, with none, a standalone client (it opens, and
    // what it sends goes nowhere).
		this._join(servers.get(pathOf(this.url)) ?? servers.get("/"));
	}

	/** Join `server` (if any), and open. */
	private _join(server: WebSocketServer | undefined): void {
		this._isClient = true;
		server?._accept(this);
		setTimeout(() => {
			this.readyState = WebSocket.OPEN;
			this.emit("open", new Event("open"));
			if (this.onopen) { this.onopen(new Event("open")); }
		}, 0);
	}

	/** An EventTarget-style listener, as `ws`'s sockets take them (hub's websocketTransport, say): handed an event with
	 *  its `type` — `open`, `message` (its `data`), `close` (its `code` and `reason`), `error`. */
	addEventListener(type: string, listener: (event: Event) => void, options?: { "once"?: boolean }): void {
		const ofType = this._listeners.get(type) ?? new Map<unknown, (...args: unknown[]) => void>();

		if (ofType.has(listener)) {
			return;
		}

		const handler = (event?: unknown): void => {
			if (options?.once === true) {
				this.removeEventListener(type, listener);
			}

			listener.call(this, (event ?? new Event(type)) as Event);
		};

		ofType.set(listener, handler);
		this._listeners.set(type, ofType);
		this.on(type, handler);
	}

	removeEventListener(type: string, listener: (event: Event) => void): void {
		const handler = this._listeners.get(type)?.get(listener);

		if (handler !== undefined) {
			this._listeners.get(type)?.delete(listener);
			this.off(type, handler);
		}
	}

	private _connectNative(): void {
    // Check that the browser's native WebSocket is available and is not our own shim.
    // Only use native WebSocket in a real browser — Node.js 21+ has native WebSocket
    // but it connects to real servers, which breaks tests and isn't what the shim needs.
		const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
		const NativeWS = isBrowser && typeof globalThis.WebSocket === "function" && globalThis.WebSocket !== (WebSocket as any)
			? globalThis.WebSocket
			: null;

		if (!NativeWS) {
      // No native WebSocket (test env, Node.js, etc.) — act as if connected
			setTimeout(() => {
				this.readyState = WebSocket.OPEN;
				this.emit("open");
				if (this.onopen) { this.onopen(new Event("open")); }
			}, 0);

			return;
		}

		try {
			this._nativeWs = new NativeWS(this.url);
			this._nativeWs.binaryType = this.binaryType === "arraybuffer" ? "arraybuffer" : "blob";
		} catch {
			this.readyState = WebSocket.CLOSED;
			const errorEvent = new Event("error");

			this.emit("error", errorEvent);
			if (this.onerror) { this.onerror(errorEvent); }

			return;
		}

		this._nativeWs.onopen = () => {
			this.readyState = WebSocket.OPEN;
			this.emit("open");
			if (this.onopen) { this.onopen(new Event("open")); }
		};

		this._nativeWs.onmessage = (event: globalThis.MessageEvent) => {
			const msgEvent = new MessageEventPolyfill("message", { "data": event.data });

			this.emit("message", msgEvent);
			if (this.onmessage) { this.onmessage(msgEvent as unknown as MessageEvent); }
		};

		this._nativeWs.onclose = (event: globalThis.CloseEvent) => {
			this.readyState = WebSocket.CLOSED;
			this._nativeWs = null;
			const closeEvent = new CloseEventPolyfill("close", {
				"code": event.code,
				"reason": event.reason,
				"wasClean": event.wasClean
			});

			this.emit("close", closeEvent);
			if (this.onclose) { this.onclose(closeEvent); }
		};

		this._nativeWs.onerror = () => {
			const errorEvent = new Event("error");

			this.emit("error", errorEvent);
			if (this.onerror) { this.onerror(errorEvent); }
		};
	}

	send(data: string | ArrayBuffer | Uint8Array): void {
		if (this.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket is not open");
		}

    // If connected to native WebSocket (external server)
		if (this._nativeWs) {
			this._nativeWs.send(data);

			return;
		}

    // Joined in this realm: the other end receives it, a turn later, as over a socket.
		const peer = this._peer;

		if (peer !== null) {
			this._watched?.watch.frame(this._isClient, data);
			setTimeout(() => { peer._receiveMessage(data); }, 0);

			return;
		}

    // A server-side socket from handleUpgrade, with no client here
		if (this._server) {
			this._server._handleClientMessage(this, data);
		}
	}

	close(code?: number, reason?: string): void {
		if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) {
			return;
		}

		this.readyState = WebSocket.CLOSING;

    // If connected to native WebSocket, close it (onclose handler emits events)
		if (this._nativeWs) {
			this._nativeWs.close(code, reason);

			return;
		}

		// The other end hears it close.
		const peer = this._peer;

		this._peer = null;
		this._toldClosed(code || 1000, reason || "");

		if (peer !== null) {
			setTimeout(() => { peer._remoteClose(code, reason); }, 0);
		}

		setTimeout(() => {
			this.readyState = WebSocket.CLOSED;
			const closeEvent = new CloseEventPolyfill("close", {
				"code": code || 1000,
				"reason": reason || "",
				"wasClean": true
			});

			this.emit("close", closeEvent);
			if (this.onclose) { this.onclose(closeEvent); }
		}, 0);
	}

	ping(): void {
    // No-op in browser
	}

	pong(): void {
    // No-op in browser
	}

	terminate(): void {
		if (this._nativeWs) {
			this._nativeWs.close();
			this._nativeWs = null;
		}

		// (joined here: the other end hears it go)
		const peer = this._peer;

		this._peer = null;

		if (peer !== null) {
			setTimeout(() => { peer._remoteClose(1006, "Connection terminated"); }, 0);
		}

		this._toldClosed(1006, "Connection terminated");
		this.readyState = WebSocket.CLOSED;
		const closeEvent = new CloseEventPolyfill("close", {
			"code": 1006,
			"reason": "Connection terminated",
			"wasClean": false
		});

		this.emit("close", closeEvent);
		if (this.onclose) { this.onclose(closeEvent); }
	}

  // For internal server use
	_setServer(server: WebSocketServer): void {
		this._server = server;
	}

	/** Join this socket to the other end of a connection made in this realm. */
	_setPeer(peer: WebSocket): void {
		this._peer = peer;
	}

	/** Watched by `watched` (its connection's, shared with the other end). */
	_setWatched(watched: { "watch": SocketWatch; "closed": boolean } | undefined): void {
		this._watched = watched;
	}

	/** Its connection closed: its observer told, once whichever end closes it. */
	private _toldClosed(code: number, reason: string): void {
		if (this._watched !== undefined && !this._watched.closed) {
			this._watched.closed = true;
			this._watched.watch.closed(code, reason);
		}
	}

	/** The other end closed. */
	_remoteClose(code?: number, reason?: string): void {
		if (this.readyState === WebSocket.CLOSED) {
			return;
		}

		this._peer = null;
		this.readyState = WebSocket.CLOSED;
		this._server?.clients.delete(this);
		const closeEvent = new CloseEventPolyfill("close", { "code": code || 1000, "reason": reason || "", "wasClean": true });

		this.emit("close", closeEvent);
		if (this.onclose) { this.onclose(closeEvent); }
	}

	_receiveMessage(data: unknown): void {
		const msgEvent = new MessageEventPolyfill("message", { "data": data });

		this.emit("message", msgEvent);
		if (this.onmessage) { this.onmessage(msgEvent as unknown as MessageEvent); }
	}
}

export interface ServerOptions {
	"host"?: string;
	"port"?: number;
	"server"?: unknown; // HTTP server
	"noServer"?: boolean;
	"path"?: string;
	"clientTracking"?: boolean;
	"perMessageDeflate"?: boolean | object;
	"maxPayload"?: number;
}

export class WebSocketServer extends EventEmitter {
	clients = new Set<WebSocket>();
	options: ServerOptions;
	private readonly _path: string;
	/** The port it's bound to (undefined: none). */
	private _port: number | undefined;

	constructor(options: ServerOptions = {}) {
		super();
		this.options = options;
		this._path = options.path || "/";

    // Listening (unless noServer: it takes connections only through handleUpgrade)
		if (!options.noServer) {
			servers.set(this._path, this);
		}

		// On a port of its own (`port: 0`: any free one), as `ws` binds an http server to it — or on its http server's,
		// once that listens. Either holds the process open while it's bound, as a listening server does.
		if (options.port !== undefined) {
			const port = options.port === 0 ? freePort() : options.port;

			if (bound.has(port)) {
				queueMicrotask(() => { this.emit("error", Object.assign(new Error(`listen EADDRINUSE: address already in use :::${port}`), { "code": "EADDRINUSE" })); });

				return;
			}

			this._bind(port);
			queueMicrotask(() => { this.emit("listening"); });
		} else if (options.server !== undefined) {
			const server = options.server as { "listening"?: boolean; "address": () => { "port": number } | string | null; "once": (event: string, listener: () => void) => void };
			const bind = (): void => {
				const address = server.address();

				if (address !== null && typeof address === "object") {
					this._bind(address.port);
				}
			};

			if (server.listening === true) {
				bind();
			} else {
				server.once("listening", bind);
			}
		}
	}

	private _bind(port: number): void {
		this._port = port;
		bound.set(port, [...bound.get(port) ?? [], this]);

		if (this.options.port !== undefined) {
			keepAlive()?.retain(this);
		}
	}

	/** A client in this realm connects: its server-side socket, joined to it, is this server's new connection — told to
	 *  the realm's observer. */
	_accept(client: WebSocket): void {
		const ws = new WebSocket("internal://" + this._path);
		const url = new URL(client.url, "http://localhost");
		const watch = observer?.({ "url": client.url, "port": this._port, "path": url.pathname });
		const watched = watch === undefined ? undefined : { "watch": watch, "closed": false };

		ws._setServer(this);
		ws._setPeer(client);
		client._setPeer(ws);
		ws._setWatched(watched);
		client._setWatched(watched);

		if (this.options.clientTracking !== false) {
			this.clients.add(ws);
		}

		// (the upgrade request, as `ws` hands it over: its path and its headers — no origin, as from Node)
		setTimeout(() => { this.emit("connection", ws, { "url": url.pathname + url.search, "headers": { "host": url.host, "upgrade": "websocket", "connection": "Upgrade" } }); }, 0);
	}

	_handleClientMessage(client: WebSocket, data: unknown): void {
    // Broadcast to server-side handlers
		const msgEvent = new MessageEventPolyfill("message", { "data": data });

		client.emit("message", msgEvent);
	}

	handleUpgrade(
		request: unknown,
		socket: unknown,
		head: unknown,
		callback: (ws: WebSocket, request: unknown) => void
	): void {
    // Create WebSocket for this upgrade
		const ws = new WebSocket("internal://" + this._path);

		ws._setServer(this);

		if (this.options.clientTracking !== false) {
			this.clients.add(ws);
		}

    // Async callback
		setTimeout(() => {
			callback(ws, request);
			this.emit("connection", ws, request);
		}, 0);
	}

	close(callback?: () => void): void {
    // Close all clients
		for (const client of this.clients) {
			client.close(1001, "Server shutting down");
		}

		this.clients.clear();

    // Remove from registry
		if (servers.get(this._path) === this) {
			servers.delete(this._path);
		}

		if (this._port !== undefined) {
			const rest = (bound.get(this._port) ?? []).filter((server) => server !== this);

			if (rest.length === 0) {
				bound.delete(this._port);
			} else {
				bound.set(this._port, rest);
			}

			this._port = undefined;
			keepAlive()?.release(this);
		}

		this.emit("close");

		if (callback) {
			setTimeout(callback, 0);
		}
	}

	address(): { "port": number; "family": string; "address": string } | null {
		return {
			"port": this._port ?? this.options.port ?? 0,
			"family": "IPv4",
			"address": this.options.host || "0.0.0.0"
		};
	}
}

/** A port no server here is bound to, as net's `listen(0)` picks one. */
function freePort(): number {
	for (;;) {
		const port = 3000 + Math.floor(Math.random() * 1000);

		if (!bound.has(port)) {
			return port;
		}
	}
}

/**
 * The global `WebSocket` for a realm whose servers are this shim's (a Node program's, run here): a
 * `ws://localhost:<port>` URL a server here is bound to is that server, joined in memory as `require("ws")`'s client
 * is (and seen the same way: observeSockets); any other is `native`'s — the browser's (or, with none, this shim's).
 */
export function webSocketGlobal(native: typeof globalThis.WebSocket | undefined): typeof globalThis.WebSocket {
	if (native === undefined) {
		return WebSocket as unknown as typeof globalThis.WebSocket;
	}

	return new Proxy(native, {
		"construct": (target, args: [string | URL, (string | string[])?], newTarget) => (localServer(String(args[0])) === undefined ? Reflect.construct(target, args, newTarget) as object : new WebSocket(String(args[0]), args[1]))
	});
}

// Export WebSocket and Server
export default WebSocket;
export const Server = WebSocketServer;

// Additional exports for compatibility
export function createWebSocketStream() {
	throw new Error("createWebSocketStream is not supported in browser");
}
