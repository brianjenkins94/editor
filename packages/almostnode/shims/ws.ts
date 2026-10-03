/**
 * ws (WebSocket) shim for browser environment: a script's `require("ws")`.
 *
 * A `ws://` or `wss://` URL is a real server somewhere: the browser's own WebSocket reaches it. Any other URL (`/socket`,
 * `http://localhost:8080/socket`) is a WebSocketServer in this same realm, listening on that path: client and server are
 * joined in memory, each side's `send` arriving at the other — no channel between realms, so nothing leaks to another
 * context (or another tab of the origin).
 */

import { EventEmitter } from "./events";

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

/** The path a client's URL asks for: `/socket` of `/socket` or `http://localhost:8080/socket`. */
function pathOf(url: string): string {
	try {
		return new URL(url, "http://localhost").pathname;
	} catch {
		return url;
	}
}

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

    // For external WebSocket connections, use the browser's native WebSocket.
    // This allows libraries like the Convex CLI (which require('ws')) to
    // communicate with real remote servers.
		if (this.url.startsWith("ws://") || this.url.startsWith("wss://")) {
			this._connectNative();

			return;
		}

    // Any other URL: a server in this realm, listening on its path — or, with none, a standalone client (it opens, and
    // what it sends goes nowhere).
		const server = servers.get(pathOf(this.url)) ?? servers.get("/");

		server?._accept(this);
		setTimeout(() => {
			this.readyState = WebSocket.OPEN;
			this.emit("open");
			if (this.onopen) { this.onopen(new Event("open")); }
		}, 0);
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

	constructor(options: ServerOptions = {}) {
		super();
		this.options = options;
		this._path = options.path || "/";

    // Listening (unless noServer: it takes connections only through handleUpgrade)
		if (!options.noServer) {
			servers.set(this._path, this);
		}
	}

	/** A client in this realm connects: its server-side socket, joined to it, is this server's new connection. */
	_accept(client: WebSocket): void {
		const ws = new WebSocket("internal://" + this._path);

		ws._setServer(this);
		ws._setPeer(client);
		client._setPeer(ws);

		if (this.options.clientTracking !== false) {
			this.clients.add(ws);
		}

		setTimeout(() => { this.emit("connection", ws, { "url": client.url }); }, 0);
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

		this.emit("close");

		if (callback) {
			setTimeout(callback, 0);
		}
	}

	address(): { "port": number; "family": string; "address": string } | null {
		return {
			"port": this.options.port || 0,
			"family": "IPv4",
			"address": this.options.host || "0.0.0.0"
		};
	}
}

// Export WebSocket and Server
export default WebSocket;
export const Server = WebSocketServer;

// Additional exports for compatibility
export function createWebSocketStream() {
	throw new Error("createWebSocketStream is not supported in browser");
}
