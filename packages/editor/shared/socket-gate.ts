/**
 * What a preview's page can't be stopped from by its service worker: a WebSocket or a peer connection never comes to it as a
 * fetch. So each page of a server is given this (the service worker puts it first in the page), which asks the service worker,
 * as a fetch of `endpoint`, before one's opened (RUNNING.md, *Rules*). A socket to the page's own machine isn't asked about:
 * it's its own server, or its own run's.
 *
 * It runs in the page, from its text: it closes over nothing.
 */
export function installSocketGate(endpoint: string): void {
	const decided = async (capability: string, resource: string): Promise<boolean> => fetch(endpoint, { "method": "POST", "body": JSON.stringify({ "capability": capability, "resource": resource }) }).then(async (response) => response.json()).then((answer: { "allow"?: boolean }) => answer.allow === true, () => false);
	const local = (url: URL): boolean => ["localhost", "127.0.0.1", "[::1]", location.hostname].includes(url.hostname);
	const Real = globalThis.WebSocket;
	const EVENTS = ["open", "message", "error", "close"] as const;

	/** A WebSocket that opens once it's been allowed: what's sent meanwhile is kept, and refused, it errors and closes. */
	class GatedSocket extends EventTarget {
		public static readonly CONNECTING = 0;
		public static readonly OPEN = 1;
		public static readonly CLOSING = 2;
		public static readonly CLOSED = 3;

		public readonly CONNECTING = 0;
		public readonly OPEN = 1;
		public readonly CLOSING = 2;
		public readonly CLOSED = 3;
		public readonly url: string;
		public onopen: ((event: Event) => void) | null = null;
		public onmessage: ((event: Event) => void) | null = null;
		public onerror: ((event: Event) => void) | null = null;
		public onclose: ((event: Event) => void) | null = null;
		private real: WebSocket | undefined;
		private refused = false;
		private closedEarly = false;
		private type: BinaryType = "blob";
		private readonly kept: Parameters<WebSocket["send"]>[0][] = [];

		public constructor(url: string, protocols?: string | string[]) {
			super();
			this.url = url;
			void decided("net.ws", url).then((allow) => {
				if (this.closedEarly) {
					return;
				}

				if (!allow) {
					this.refused = true;
					this.tell(new Event("error"));
					this.tell(new CloseEvent("close", { "code": 1006, "reason": "refused by the policy", "wasClean": false }));

					return;
				}

				const real = new Real(url, protocols);

				real.binaryType = this.type;
				this.real = real;

				for (const name of EVENTS) {
					real.addEventListener(name, (event) => {
						if (name === "open") {
							for (const data of this.kept.splice(0)) {
								real.send(data);
							}
						}

						this.tell(event instanceof MessageEvent ? new MessageEvent("message", { "data": event.data as unknown, "origin": event.origin }) : event instanceof CloseEvent ? new CloseEvent("close", { "code": event.code, "reason": event.reason, "wasClean": event.wasClean }) : new Event(name));
					});
				}
			});
		}

		public get readyState(): number {
			return this.real?.readyState ?? (this.refused || this.closedEarly ? 3 : 0);
		}

		public get protocol(): string {
			return this.real?.protocol ?? "";
		}

		public get extensions(): string {
			return this.real?.extensions ?? "";
		}

		public get bufferedAmount(): number {
			return this.real?.bufferedAmount ?? 0;
		}

		public get binaryType(): BinaryType {
			return this.real?.binaryType ?? this.type;
		}

		public set binaryType(type: BinaryType) {
			this.type = type;

			if (this.real !== undefined) {
				this.real.binaryType = type;
			}
		}

		public send(data: Parameters<WebSocket["send"]>[0]): void {
			if (this.real?.readyState === 1) {
				this.real.send(data);
			} else {
				this.kept.push(data);
			}
		}

		public close(code?: number, reason?: string): void {
			if (this.real === undefined) {
				this.closedEarly = true;
			} else {
				this.real.close(code, reason);
			}
		}

		private tell(event: Event): void {
			this.dispatchEvent(event);
			(this[`on${event.type}` as "onopen"])?.(event);
		}
	}

	globalThis.WebSocket = new Proxy(Real, {
		construct(target, [url, protocols]: [string | URL, (string | string[])?]) {
			const asked = new URL(url, location.href);

			return local(asked) ? Reflect.construct(target, [asked, protocols]) as WebSocket : new GatedSocket(asked.href, protocols);
		}
	});

	// A peer connection: asked about when it would first reach out. Refused, what it was asked for fails.
	if (globalThis.RTCPeerConnection !== undefined) {
		const proto = globalThis.RTCPeerConnection.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

		for (const name of ["createOffer", "createAnswer"]) {
			const real = proto[name]!;

			proto[name] = async function(this: RTCPeerConnection, ...args: unknown[]): Promise<unknown> {
				if (!await decided("net.webrtc", "")) {
					throw new DOMException("refused by the policy", "NotAllowedError");
				}

				return real.apply(this, args);
			};
		}
	}
}
