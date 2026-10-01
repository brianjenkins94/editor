/**
 * What every preview realm's tap does — a page's (page-tap.ts) and a worker's (worker-tap.ts): capture its console and
 * uncaught errors, and gate the network the service worker can't see. Each tap supplies where a record goes (`send`)
 * and how a capability is decided (`decide`, a Promise of allow that fails closed).
 */

export interface TapRecord {
	"level": "trace" | "debug" | "info" | "warn" | "error";
	"message": string;
	"attrs"?: Record<string, unknown>;
}

export type Send = (record: TapRecord) => void;
export type Decide = (kind: string, resource: string) => Promise<boolean>;

function format(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Console calls, and uncaught errors and rejections, → `send` (the console still prints). */
export function installConsoleTap(send: Send): void {
	const levels: [keyof Console, TapRecord["level"]][] = [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"], ["debug", "debug"]];

	for (const [method, level] of levels) {
		const original = typeof console[method] === "function" ? (console[method] as (...args: unknown[]) => void).bind(console) : () => undefined;

		(console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
			try {
				send({ "level": level, "message": args.map(format).join(" ") });
			} catch { /* a tap never breaks the app */ }

			original(...args);
		};
	}

	addEventListener("error", (event) => {
		const error = event as ErrorEvent;

		send({ "level": "error", "message": error.message || "uncaught error", "attrs": { "src": error.filename, "line": error.lineno, "col": error.colno, "stack": (error.error as Error | undefined)?.stack } });
	});
	addEventListener("unhandledrejection", (event) => {
		const reason = (event as PromiseRejectionEvent).reason as { "message"?: string; "stack"?: string } | undefined;

		send({ "level": "error", "message": "unhandledrejection: " + (reason?.message ?? String(reason)), "attrs": { "stack": reason?.stack } });
	});
}

/**
 * WebSocket, which the service worker's net gate can't see (excluded from SW fetch by spec): a DEFERRED PROXY that
 * buffers send()/listeners and only opens the real socket once `decide` allows it (else fires error + close). A sync
 * constructor can't await a decision, hence the proxy.
 */
export function installSocketGate(decide: Decide): void {
	const Original = globalThis.WebSocket as typeof WebSocket | undefined;

	if (Original === undefined) {
		return;
	}

	// A fresh event to redispatch on the proxy — an Event can be dispatched only once.
	const relay = (event: Event): Event => {
		if (event.type === "message") {
			const message = event as MessageEvent;

			return new MessageEvent("message", { "data": message.data, "origin": message.origin, "lastEventId": message.lastEventId });
		}

		if (event.type === "close") {
			const close = event as CloseEvent;

			return new CloseEvent("close", { "code": close.code, "reason": close.reason, "wasClean": close.wasClean });
		}

		return new Event(event.type);
	};

	class GatedWebSocket extends EventTarget {
		public static readonly CONNECTING = Original!.CONNECTING;
		public static readonly OPEN = Original!.OPEN;
		public static readonly CLOSING = Original!.CLOSING;
		public static readonly CLOSED = Original!.CLOSED;
		public readonly url: string;
		public protocol = "";
		public extensions = "";
		public binaryType: BinaryType = "blob";
		public readyState: number = Original!.CONNECTING;
		public bufferedAmount = 0;
		private real: WebSocket | undefined;
		private queue: unknown[] = [];
		private closed = false;
		private closeArgs: [number?, string?] | undefined;
		/** The on* handlers (the accessors below). */
		public readonly handlers: Record<string, EventListener | null> = {};

		public constructor(url: string | URL, protocols?: string | string[]) {
			super();
			this.url = String(url);
			void decide("net.ws", this.url).then((allow) => {
				if (allow) {
					this.open(url, protocols);
				} else {
					this.deny();
				}
			});
		}

		public send(data: unknown): void {
			if (this.closed) {
				return;
			}

			if (this.real !== undefined && this.readyState === Original!.OPEN) {
				this.real.send(data as string);
			} else {
				this.queue.push(data);
			}
		}

		public close(code?: number, reason?: string): void {
			this.closed = true;
			this.closeArgs = [code, reason];

			if (this.real === undefined) {
				this.readyState = Original!.CLOSING;
			} else {
				try {
					this.real.close(code, reason);
				} catch { /* already closing */ }
			}
		}

		private open(url: string | URL, protocols?: string | string[]): void {
			const real = protocols === undefined ? new Original!(url) : new Original!(url, protocols);

			this.real = real;

			try {
				real.binaryType = this.binaryType;
			} catch { /* not settable */ }

			for (const type of ["open", "message", "error", "close"]) {
				real.addEventListener(type, (event) => {
					if (type === "open") {
						this.readyState = Original!.OPEN;
						this.protocol = real.protocol;
						this.extensions = real.extensions;
						this.flush();
					} else if (type === "close") {
						this.readyState = Original!.CLOSED;
					}

					this.dispatchEvent(relay(event));
				});
			}

			if (this.closed) {
				try {
					real.close(...(this.closeArgs ?? []));
				} catch { /* already closing */ }
			}
		}

		private flush(): void {
			for (const data of this.queue.splice(0)) {
				try {
					this.real?.send(data as string);
				} catch { /* dropped */ }
			}
		}

		private deny(): void {
			this.readyState = Original!.CLOSED;
			this.dispatchEvent(new Event("error"));
			this.dispatchEvent(new CloseEvent("close", { "code": 4403, "reason": "Blocked by capability policy", "wasClean": false }));
		}
	}

	// on* handlers as accessors, so dispatchEvent alone delivers to both addEventListener and the on* handler.
	for (const name of ["onopen", "onmessage", "onerror", "onclose"]) {
		const type = name.slice(2);

		Object.defineProperty(GatedWebSocket.prototype, name, {
			"configurable": true,
			"get": function(this: { "handlers": Record<string, EventListener | null> }) { return this.handlers[name] ?? null; },
			"set": function(this: EventTarget & { "handlers": Record<string, EventListener | null> }, handler: unknown) {
				const previous = this.handlers[name];

				if (previous) {
					this.removeEventListener(type, previous);
				}

				this.handlers[name] = typeof handler === "function" ? handler as EventListener : null;

				if (this.handlers[name]) {
					this.addEventListener(type, this.handlers[name]!);
				}
			}
		});
	}

	(globalThis as { "WebSocket": unknown }).WebSocket = GatedWebSocket;
}
