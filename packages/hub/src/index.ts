/**
 * @brianjenkins94/hub — composable message hubs.
 *
 * A hub is a subject-routed message bus for one runtime context (a window, an iframe, a worker). Hubs compose
 * into a TREE by linking their transports: a workbench's hub links its extension pod's hub, which links each of
 * its worker hubs; a game's host hub links each box's hub. Routing is LOCAL-FIRST with INTEREST propagation —
 * a message only crosses a link if something on the far side actually subscribed to its subject — so a hub runs
 * fully standalone (it's just the root of its own tree) and only the traffic others want ever leaves it. That's
 * the whole point: the extension keeps working with no harness (its pod hub is a root), and when a harness is
 * present the pod hub links up and its surface traffic federates, without either side importing the other.
 *
 * Addressing is NATS-style dotted subjects: `render.mutation`, `log.editor`, `peer.<id>` for point-to-point.
 * Patterns use `*` (one token) and `>` (the rest): `log.>`, `peer.*`. No delivery guarantees, no persistence —
 * this is a router, not a broker; wire hubs as a TREE (no cycles) so a message never loops.
 */

/** A message on the bus. `subject` is the address; `data` is the payload. */
export interface Envelope {
	"subject": string;
	"data"?: unknown;
	/** Originating hub id — diagnostics and replies (address `peer.<from>`). */
	"from"?: string;
	/** W3C-shaped trace context of the SENDING span (from @brianjenkins94/util/logger), set when a message
	 *  causes work elsewhere. The receiving seam opens a child span under it (`parentSpanId` = the sender's
	 *  span), so one operation stitches into a single trace across contexts and constructs an OTel span cleanly. */
	"traceContext"?: { "traceId": string; "parentSpanId": string };
}

/** A duplex channel to one other hub. Transport-agnostic so window/MessagePort/Worker (and later WebSocket,
 *  WebRTC) all plug in. `listen` registers the sink and returns a disposer. */
export interface Transport {
	"send": (message: unknown) => void;
	"listen": (onMessage: (message: unknown) => void) => () => void;
}

/** Where a delivered message came from: the adjacent link it arrived on, or undefined for a publish on this hub. */
export interface Origin {
	"link"?: LinkInfo;
}

export type Handler = (data: unknown, envelope: Envelope, origin: Origin) => void;

export interface HubOptions {
	/** Stable id (used for `peer.<id>` addressing and diagnostics). Auto-generated when omitted. */
	"id"?: string;
}

// Every hub message is wrapped under this key before it hits a transport, so a shared channel (a window with
// other postMessage traffic — HMR, devtools) never confuses foreign messages for bus traffic, and vice versa.
const WIRE = "\0hub"; // a NUL-prefixed key no ordinary postMessage payload uses (escaped, so this file stays text)

/** Control — a hub telling a link about interest (`sub`/`unsub` a subject) or, on connect, `hello`: "I've
 *  linked; re-send me your interest." `hello` makes the handshake robust on a LOSSY transport (raw window
 *  postMessage drops messages sent before the peer is listening; a MessagePort queues, so it wouldn't need it).
 *  Kept off the Envelope shape so data and control never collide. `hello` also carries the sender's hub `id`, so
 *  each end knows WHICH hub sits across a link (optional on the wire: an older peer simply stays anonymous). */
export interface Control {
	"hub": "sub" | "unsub" | "hello";
	"subject"?: string;
	"id"?: string;
	/** Set on the `hello` sent back in answer to a peer's `hello` — so an end whose first `hello` was lost still
	 *  learns our id. Never answered itself, so hellos can't ping-pong. */
	"reply"?: boolean;
	/** On a `hello`, from a hub that ASSIGNED the peer its id (LinkOptions.peer): that id — who the peer is to it,
	 *  and to everything past it (it stamps `from` with it, and permits the peer only `$rpc.reply.<it>`). */
	"you"?: string;
}

function isControl(message: unknown): message is Control {
	const hub = (message as Control | null)?.hub;

	return typeof message === "object" && message !== null && (hub === "sub" || hub === "unsub" || hub === "hello");
}

function isEnvelope(message: unknown): message is Envelope {
	return typeof message === "object" && message !== null && typeof (message as Envelope).subject === "string";
}

/** Does subscription `pattern` match `subject`? NATS semantics: `*` matches one token, `>` matches the rest. */
export function matches(pattern: string, subject: string): boolean {
	if (pattern === subject) {
		return true;
	}

	const patternTokens = pattern.split(".");
	const subjectTokens = subject.split(".");

	for (let index = 0; index < patternTokens.length; index += 1) {
		const token = patternTokens[index];

		if (token === ">") {
			return subjectTokens.length > index;
		}

		if (index >= subjectTokens.length || (token !== "*" && token !== subjectTokens[index])) {
			return false;
		}
	}

	return patternTokens.length === subjectTokens.length;
}

/** A connected transport plus the interest tracked in each direction. */
interface Link {
	/** Stable id of this link within its hub (`link-1`, `link-2`, …) — links are otherwise anonymous objects. */
	"id": string;
	/** Id of the hub at the other end, learned from its `hello`; undefined until then (or for an older peer). */
	"peerId"?: string;
	"transport": Transport;
	/** Subjects the remote side (its whole subtree) wants — so we know what to forward to it. */
	"remoteInterest": Set<string>;
	/** Subjects we've told the remote we want — the diff base for re-advertising. */
	"advertised": Set<string>;
	/** False for a link that must not be joined to other such links (see LinkOptions). */
	"transit": boolean;
	/** True when `peerId` was assigned by this hub (LinkOptions.peer) rather than learned from the peer's hello. */
	"assigned": boolean;
	/** On an uplink (LinkOptions.uplink): the id the hub at the other end assigned US (its hello's `you`). */
	"uplink": boolean;
	"knownAs"?: string;
	"permissions"?: LinkPermissions;
	"detach": () => void;
	/** Settles `link()`'s `ready`: true on the peer's first hello, false if unlinked before. */
	"settle": (ready: boolean) => void;
}

/** What `link()` returns: the unlink function, plus
 * - `id`: the link's id in this hub — what taps, `inspect()` and handlers' `origin.link` call it — so a caller can tell
 *   which messages arrived over the link it made;
 * - `ready`: resolves true once the peer's hello has arrived, and with it the peer's interest (a hub advertises its
 *   interest before every hello it sends), or false if the link is gone first. A message published before then can go
 *   nowhere: a hub forwards only what it knows the far side wants. So `await ready` before a one-off publish across a
 *   new link (or wait for `whenInterested`). */
export type LinkHandle = (() => void) & { readonly "id": string; readonly "ready": Promise<boolean> };

/** One link as `inspect()` / taps report it. */
export interface LinkInfo {
	"id": string;
	"peerId"?: string;
}

/** A hub's topology, as `inspect()` returns it: its own subscriptions and, per link, the peer plus the interest
 *  tracked in each direction. Plain data — safe to publish or JSON-serialize. */
export interface HubSnapshot {
	"id": string;
	"subscriptions": string[];
	"links": (LinkInfo & { "remoteInterest": string[]; "advertised": string[]; "permissions"?: LinkPermissions })[];
}

/**
 * What a tap sees — every frame a hub handles, at the points where it actually happens:
 * - `publish`: a message originated on this hub;
 * - `deliver`: a message reached `handlers` local handlers (only when at least one matched);
 * - `send` / `receive`: a frame (envelope or control) went out on / came in from a link;
 * - `topology`: links, peers, subscriptions, interest or permissions changed — `inspect()` for the new state;
 * - `deny`: a link's permissions stopped a message — one its peer may not `publish`, or one it may not receive
 *   (`subscribe`) although it asked for it.
 */
export type TapEvent =
	| { "type": "publish"; "envelope": Envelope }
	| { "type": "deliver"; "envelope": Envelope; "handlers": number; "link"?: LinkInfo }
	| { "type": "send" | "receive"; "link": LinkInfo; "frame": Envelope | Control }
	| { "type": "deny"; "link": LinkInfo; "envelope": Envelope; "direction": "publish" | "subscribe" }
	| { "type": "topology" };

export type Tap = (event: TapEvent) => void;

/**
 * What may cross a link, as subject patterns (NATS wildcards). An omitted list allows everything. Enforced by the hub
 * that owns the link, so the peer can't opt out — this is how a hub confines an untrusted peer (a game client) to its
 * own traffic.
 */
export interface LinkPermissions {
	/** Subjects the peer may publish across this link. Anything else it sends is dropped. */
	"publish"?: string[];
	/** Subjects the peer may receive across this link. Nothing else is forwarded to it, whatever it subscribes to —
	 *  so a broad wildcard subscription still only receives what's allowed. */
	"subscribe"?: string[];
}

export interface LinkOptions {
	/** Default true. A hub that links SEVERAL separate trees — a debugger connected to every open tab — must not
	 *  join them into one: with `transit: false`, traffic and interest never pass from one non-transit link to
	 *  another (each tree still reaches this hub, and this hub reaches each tree), so a request in one tab can't be
	 *  answered by another tab. */
	"transit"?: boolean;
	/** This link goes UP, to the hub that decides who we are: the id it assigned us (its hello's `you`) is taken as ours
	 *  there (Hub.knownAs). Only an uplink's word counts — a child, or any other peer, can't rename this hub. */
	"uplink"?: boolean;
	/** The id this hub knows the peer by. It overrides whatever the peer claims in its hello, and every message
	 *  arriving over the link is stamped `from` it — so, past this hub, `from` is authenticated (as far as the hubs in
	 *  between are trusted). Assign it when this hub decides who the peer is (it created the iframe, seated the
	 *  player); leave it out to take the peer's word. The peer is told (its `hello` says `you`, Hub.knownAs), so its RPC
	 *  replies come back under this id, the only one the link lets through to it. */
	"peer"?: string;
	"permissions"?: LinkPermissions;
}

/** Does `patterns` allow `subject`? An omitted list allows everything. */
function permits(patterns: string[] | undefined, subject: string): boolean {
	return patterns === undefined || patterns.some((pattern) => matches(pattern, subject));
}

/** May a message (or interest) from link `from` pass on to link `to`? Never between two non-transit links. */
function crosses(from: Link | undefined, to: Link): boolean {
	return from === undefined || from.transit || to.transit;
}

export class Hub {
	public readonly id: string;

	private readonly links = new Set<Link>();
	// subject pattern → local handlers subscribed to it.
	private readonly handlers = new Map<string, Set<Handler>>();
	private readonly taps = new Set<Tap>();
	private linkIdPool = 0;

	public constructor(options: HubOptions = {}) {
		this.id = options.id ?? "hub-" + Math.random().toString(36).slice(2, 10);
	}

	/** Subscribe a local handler to a subject (or pattern). Returns an unsubscribe function. */
	public subscribe(subject: string, handler: Handler): () => void {
		let set = this.handlers.get(subject);

		if (set === undefined) {
			set = new Set();
			this.handlers.set(subject, set);
		}

		set.add(handler);
		this.readvertise();
		this.emit({ "type": "topology" });

		return () => {
			const current = this.handlers.get(subject);

			if (current === undefined) {
				return;
			}

			current.delete(handler);

			if (current.size === 0) {
				this.handlers.delete(subject);
			}

			this.readvertise();
			this.emit({ "type": "topology" });
		};
	}

	/** Publish a message. It reaches every local handler and every linked subtree that wants the subject.
	 *  Pass `traceContext` (the caller's active span) when this message causes work a receiver should trace. */
	public publish(subject: string, data?: unknown, options: { "traceContext"?: Envelope["traceContext"] } = {}): void {
		const envelope: Envelope = { "subject": subject, "data": data, "from": this.id, "traceContext": options.traceContext };

		this.emit({ "type": "publish", "envelope": envelope });
		this.route(envelope, undefined);
	}

	/** Would a message on `subject` published HERE reach anyone right now — a local handler, or a link whose subtree
	 *  wants it AND whose permissions let it through (an interested link that would refuse it is no listener)? */
	public interested(subject: string): boolean {
		for (const pattern of this.handlers.keys()) {
			if (matches(pattern, subject)) {
				return true;
			}
		}

		for (const link of this.links) {
			if (!permits(link.permissions?.subscribe, subject)) {
				continue;
			}

			for (const pattern of link.remoteInterest) {
				if (matches(pattern, subject)) {
					return true;
				}
			}
		}

		return false;
	}

	/** Resolve true once `subject` would reach someone (see `interested`), or false after `timeoutMs` — for a one-off
	 *  message that mustn't be lost to a link whose interest hasn't arrived yet. (For state, publishing on every change
	 *  is simpler and self-healing.) */
	public whenInterested(subject: string, timeoutMs: number): Promise<boolean> {
		if (this.interested(subject)) {
			return Promise.resolve(true);
		}

		return new Promise((resolve) => {
			const finish = (value: boolean): void => {
				clearTimeout(timer);
				untap();
				resolve(value);
			};
			const timer = setTimeout(() => { finish(false); }, timeoutMs);
			const untap = this.tap((event) => {
				if (event.type === "topology" && this.interested(subject)) {
					finish(true);
				}
			});
		});
	}

	/** This hub's topology right now: subscriptions, links, their peers and the interest in each direction. */
	/** The id our uplink (LinkOptions.uplink) assigned us, if it did (LinkOptions.peer, told in its hello) — an untrusted
	 *  child under an edge is its assigned id there, whatever it calls itself. Usually one, or none. */
	public knownAs(): string[] {
		return [...new Set([...this.links].map((link) => link.knownAs).filter((id): id is string => id !== undefined))];
	}

	public inspect(): HubSnapshot {
		return {
			"id": this.id,
			"subscriptions": [...this.handlers.keys()],
			"links": [...this.links].map((link) => ({
				"id": link.id,
				"peerId": link.peerId,
				"remoteInterest": [...link.remoteInterest],
				"advertised": [...link.advertised],
				...link.permissions === undefined ? {} : { "permissions": link.permissions }
			}))
		};
	}

	/** Replace the permissions of the link(s) to `peer` (see LinkPermissions) — e.g. once a client is seated and its
	 *  team known. `undefined` lifts them. Returns whether any link matched. */
	public permit(peer: string, permissions: LinkPermissions | undefined): boolean {
		let found = false;

		for (const link of this.links) {
			if (link.peerId === peer) {
				link.permissions = permissions;
				found = true;
			}
		}

		if (found) {
			this.emit({ "type": "topology" });
		}

		return found;
	}

	/** Observe every frame this hub handles (see `TapEvent`). For diagnostics — a tap must not publish on this hub
	 *  synchronously (it would observe itself); batch and publish later instead. A throwing tap is ignored. Returns
	 *  a disposer. */
	public tap(tap: Tap): () => void {
		this.taps.add(tap);

		return () => { this.taps.delete(tap); };
	}

	private emit(event: TapEvent): void {
		for (const tap of this.taps) {
			try {
				tap(event);
			} catch { /* diagnostics must never break routing */ }
		}
	}

	/** Link another hub over `transport` (both ends call `link`, one per channel end). The two hubs now
	 *  federate: interest and matching messages flow across. Returns an unlink function, with `ready` (see
	 *  LinkHandle). Wire a TREE. */
	public link(transport: Transport, options: LinkOptions = {}): LinkHandle {
		this.linkIdPool += 1;

		let settle: (ready: boolean) => void = () => undefined;
		const ready = new Promise<boolean>((resolve) => { settle = resolve; });
		const link: Link = { "id": "link-" + this.linkIdPool, "peerId": options.peer, "transport": transport, "remoteInterest": new Set(), "advertised": new Set(), "transit": options.transit !== false, "assigned": options.peer !== undefined, "uplink": options.uplink === true, "permissions": options.permissions, "detach": () => undefined, "settle": settle };

		link.detach = transport.listen((raw) => { this.receive(link, raw); });
		this.links.add(link);
		this.emit({ "type": "topology" });
		this.readvertise(); // tell the new link everything we (and our other links) want
		// ask it to (re-)send its interest, in case ours/theirs raced a lossy transport — and say who we are
		this.wire(link, { "hub": "hello", "id": this.id, ...link.assigned ? { "you": link.peerId } : {} });

		return Object.assign(() => { this.unlink(link); }, { "id": link.id, "ready": ready });
	}

	private unlink(link: Link): void {
		if (!this.links.delete(link)) {
			return;
		}

		link.detach();
		link.settle(false);
		this.emit({ "type": "topology" });
		this.readvertise(); // our aggregate interest may have shrunk for the remaining links
	}

	private receive(link: Link, raw: unknown): void {
		const message = (raw as Record<string, unknown> | null | undefined)?.[WIRE];

		if (this.taps.size > 0 && (isControl(message) || isEnvelope(message))) {
			this.emit({ "type": "receive", "link": { "id": link.id, "peerId": link.peerId }, "frame": message });
		}

		if (isControl(message)) {
			if (message.hub === "hello") {
				if (!link.assigned && message.id !== undefined && message.id !== link.peerId) {
					link.peerId = message.id;
					this.emit({ "type": "topology" });
				}

				// Who we are to the hub that assigned our id — only from our uplink: no other peer can rename us.
				if (link.uplink && typeof message.you === "string" && message.you !== link.knownAs) {
					link.knownAs = message.you;
					this.emit({ "type": "topology" });
				}

				// Peer (re)connected and may have missed our interest (a lossy transport can drop what we sent
				// before it was listening). Forget what we think it knows and re-send our full interest — BEFORE
				// answering, so every hello we send follows our interest: a peer that has our hello knows what we want.
				link.advertised.clear();
				this.readvertise();

				if (message.reply !== true) {
					this.wire(link, { "hub": "hello", "id": this.id, "reply": true, ...link.assigned ? { "you": link.peerId } : {} });
				}

				// The peer's interest came ahead of its hello (the same rule, on its side): it's known now.
				link.settle(true);

				return;
			}

			if (message.subject !== undefined) {
				if (message.hub === "sub") {
					link.remoteInterest.add(message.subject);
				} else {
					link.remoteInterest.delete(message.subject);
				}

				this.emit({ "type": "topology" });
				this.readvertise(); // a link's interest changed → what we advertise to OTHER links may change
			}

			return;
		}

		if (isEnvelope(message)) {
			// An assigned peer is who it is: stamp that, whatever the frame claims.
			const envelope = link.assigned && message.from !== link.peerId ? { ...message, "from": link.peerId } : message;

			if (!permits(link.permissions?.publish, envelope.subject)) {
				this.emit({ "type": "deny", "link": { "id": link.id, "peerId": link.peerId }, "envelope": envelope, "direction": "publish" });

				return;
			}

			this.route(envelope, link);
		}
	}

	/** Deliver `envelope` to local handlers and forward it to interested links — never back to `from` (a tree
	 *  has no cycles, so that's all the loop-prevention we need). `from` is undefined for a local publish. */
	private route(envelope: Envelope, from: Link | undefined): void {
		// Snapshot matching handlers before invoking — a handler may (un)subscribe or (un)link mid-delivery.
		const toInvoke: Handler[] = [];

		for (const [pattern, set] of this.handlers) {
			if (matches(pattern, envelope.subject)) {
				for (const handler of set) {
					toInvoke.push(handler);
				}
			}
		}

		if (toInvoke.length > 0) {
			this.emit({ "type": "deliver", "envelope": envelope, "handlers": toInvoke.length, "link": from === undefined ? undefined : { "id": from.id, "peerId": from.peerId } });
		}

		const origin: Origin = { "link": from === undefined ? undefined : { "id": from.id, "peerId": from.peerId } };

		for (const handler of toInvoke) {
			handler(envelope.data, envelope, origin);
		}

		for (const link of this.links) {
			if (link === from || !crosses(from, link)) {
				continue;
			}

			for (const pattern of link.remoteInterest) {
				if (matches(pattern, envelope.subject)) {
					if (permits(link.permissions?.subscribe, envelope.subject)) {
						this.wire(link, envelope);
					} else {
						this.emit({ "type": "deny", "link": { "id": link.id, "peerId": link.peerId }, "envelope": envelope, "direction": "subscribe" });
					}

					break;
				}
			}
		}
	}

	/** Recompute, per link, the interest we should advertise to it — our own handlers plus every OTHER link's
	 *  interest (never a link's own, so interest never echoes back) — and send only the sub/unsub deltas. This
	 *  is what keeps traffic local: a link hears about a subject only when something on THIS side wants it. */
	private readvertise(): void {
		for (const link of this.links) {
			const desired = new Set<string>(this.handlers.keys());

			for (const other of this.links) {
				if (other !== link && crosses(other, link)) {
					for (const pattern of other.remoteInterest) {
						desired.add(pattern);
					}
				}
			}

			for (const subject of desired) {
				if (!link.advertised.has(subject)) {
					link.advertised.add(subject);
					this.wire(link, { "hub": "sub", "subject": subject });
				}
			}

			for (const subject of [...link.advertised]) {
				if (!desired.has(subject)) {
					link.advertised.delete(subject);
					this.wire(link, { "hub": "unsub", "subject": subject });
				}
			}
		}
	}

	private wire(link: Link, message: Envelope | Control): void {
		if (this.taps.size > 0) {
			this.emit({ "type": "send", "link": { "id": link.id, "peerId": link.peerId }, "frame": message });
		}

		link.transport.send({ [WIRE]: message });
	}
}

/** Create a hub. */
export function createHub(options?: HubOptions): Hub {
	return new Hub(options);
}

/** The hub frame a transport message carries — a data Envelope or a Control frame — or undefined for anything else.
 *  For transports that treat traffic differently: fault injection (drop game traffic, keep control), priorities,
 *  metrics by subject. */
export function frameOf(message: unknown): Envelope | Control | undefined {
	const frame = (message as Record<string, unknown> | null | undefined)?.[WIRE];

	return isControl(frame) || isEnvelope(frame) ? frame : undefined;
}

/** `message` with the hub frame it carries replaced by `map(frame)`; anything that isn't a hub frame passes as it is.
 *  For a transport that rewrites what crosses it — the hub where another tree joins renaming that tree's ids, say. */
export function mapFrame(message: unknown, map: (frame: Envelope | Control) => Envelope | Control): unknown {
	const frame = frameOf(message);

	return frame === undefined ? message : { [WIRE]: map(frame) };
}

export interface PipeOptions {
	/** Drop a message sent while the other end isn't listening, like a window's postMessage. Default false: hold it
	 *  until the other end listens, like a MessagePort. */
	"lossy"?: boolean;
	/** How each message travels: call `deliver` — now, later, twice, or never — to hand it to the other end. Default:
	 *  on the next macrotask (like postMessage). With `frameOf(message)` this is all fault injection needs, on a real
	 *  or a simulated clock. */
	"schedule"?: (deliver: () => void, message: unknown) => void;
}

/** Two connected in-memory transports: link one hub to each end. For tests and single-process simulations — nothing
 *  to close afterwards, and nothing keeps the process alive. */
export function pipe({ lossy = false, schedule = (deliver) => { setTimeout(deliver, 0); } }: PipeOptions = {}): [Transport, Transport] {
	interface End { "listener"?: (message: unknown) => void; "held": unknown[] }

	const left: End = { "held": [] };
	const right: End = { "held": [] };
	const transport = (self: End, other: End): Transport => ({
		"send": (message) => {
			if (lossy && other.listener === undefined) {
				return;
			}

			schedule(() => {
				if (other.listener !== undefined) {
					other.listener(message);
				} else if (!lossy) {
					other.held.push(message);
				}
			}, message);
		},
		"listen": (onMessage) => {
			self.listener = onMessage;

			// Not synchronously: a hub listens before it has registered the link the messages are for.
			for (const message of self.held.splice(0)) {
				queueMicrotask(() => { onMessage(message); });
			}

			return () => {
				if (self.listener === onMessage) {
					self.listener = undefined;
				}
			};
		}
	});

	return [transport(left, right), transport(right, left)];
}

/**
 * Transport over anything with `postMessage` + `addEventListener("message")`: a `MessagePort`, a `Worker`
 * (from the page side), a worker's own global scope (`self`, from inside the worker), or a `BroadcastChannel`.
 */
export function portTransport(target: MessagePort | Worker | Window | BroadcastChannel | typeof globalThis): Transport {
	return {
		"send": (message) => { (target as MessagePort).postMessage(message); },
		"listen": (onMessage) => {
			const handler = (event: Event): void => { onMessage((event as MessageEvent).data); };

			target.addEventListener("message", handler);
			(target as MessagePort).start?.();

			return () => { target.removeEventListener("message", handler); };
		}
	};
}

/** A WebSocket-shaped endpoint: the browser `WebSocket`, the Node 24 global, or a Node `ws` socket — anything
 *  with `send` + EventTarget-style `message` events. (`readyState` is optional; 1 = OPEN, per the WS spec.) */
export interface WebSocketLike {
	"send": (data: string) => void;
	"addEventListener": (type: "message", handler: (event: { "data": unknown }) => void) => void;
	"removeEventListener": (type: "message", handler: (event: { "data": unknown }) => void) => void;
	"readyState"?: number;
}

/**
 * Transport over a WebSocket — the one link that crosses the process boundary, so a Node collector (dev-hub)
 * can join the page's hub tree. A WS carries text, so hub messages (objects) are JSON-framed on the wire; this
 * is also why records that ride it must be plain data. Link only once the socket is OPEN — interest lost to a
 * not-yet-open socket is recovered by the `hello` handshake on (re)connect. An unserializable payload (e.g. an
 * Error in a log attr) is dropped rather than thrown, so telemetry never breaks the socket.
 */
export function websocketTransport(ws: WebSocketLike): Transport {
	return {
		"send": (message) => {
			if (ws.readyState !== undefined && ws.readyState !== 1) {
				return; // not OPEN — drop; `hello` re-advertises our interest once the peer connects
			}

			let text: string;

			try {
				text = JSON.stringify(message);
			} catch {
				return; // circular / unserializable — never let a payload break the socket
			}

			ws.send(text);
		},
		"listen": (onMessage) => {
			const handler = (event: { "data": unknown }): void => {
				const raw = event.data;
				const text = typeof raw === "string" ? raw : String(raw); // Node `ws` may hand back a Buffer

				try {
					onMessage(JSON.parse(text));
				} catch { /* not a JSON frame — not ours */ }
			};

			ws.addEventListener("message", handler);

			return () => { ws.removeEventListener("message", handler); };
		}
	};
}

/**
 * Transport over the BroadcastChannel named `name`, from anywhere — a page, a worker, another tab of the origin. Every
 * same-origin context that opens the same name hears it, so it's private only in that its name is unguessable.
 * `close` closes the channel.
 */
export function channelTransport(name: string): Transport & { "close": () => void } {
	const channel = new BroadcastChannel(name);

	return { ...portTransport(channel), "close": () => { channel.close(); } };
}

/**
 * Transport between two windows (iframe ⇄ parent, opener ⇄ popup). Filtered by source window and, unless
 * `origin` is "*", by origin — so only the intended peer's messages are accepted. `target` may be a function, looked
 * up on each message: an iframe's window, before it's in the document.
 */
export function windowTransport(target: Window | (() => Window | null | undefined), origin = "*"): Transport {
	const peer = typeof target === "function" ? target : () => target;

	return {
		"send": (message) => { peer()?.postMessage(message, origin); },
		"listen": (onMessage) => {
			const handler = (event: MessageEvent): void => {
				if (event.source !== null && event.source === peer() && (origin === "*" || event.origin === origin)) {
					onMessage(event.data);
				}
			};

			globalThis.addEventListener("message", handler as EventListener);

			return () => { globalThis.removeEventListener("message", handler as EventListener); };
		}
	};
}

// ── Request / reply ─────────────────────────────────────────────────────────────────────────────--
// The bus is fire-and-forget pub/sub; this pairs a request subject with a reply so one hub can CALL another and
// await the answer — the primitive behind "an MCP server hosted in a browser tab": a Node relay `request`s a
// tool, the tab `serve`s it and replies. The reply rides a per-requester subject (`$rpc.reply.<id>`) subscribed
// ONCE up front (via createRpcClient), so its interest reaches responders before any call — no per-call race.

const RPC_CALL = "$rpc.call"; // requests: `$rpc.call.<name>`; a responder subscribes the ones it serves
const RPC_REPLY = "$rpc.reply"; // replies: `$rpc.reply.<requester id>`, correlated by `id`

/** The subject a call to `name` travels on — what a link's permissions name to let calls to it through (a pattern
 *  works too: `rpcCallSubject("tool.>")`). */
export function rpcCallSubject(name: string): string {
	return RPC_CALL + "." + name;
}

/** The subject replies to the hub known as `id` travel on (what serve replies to: the call's `from`). */
export function rpcReplySubject(id: string): string {
	return RPC_REPLY + "." + id;
}

// A cancel rides the call's own subject (`cancel: true`, same id), so it reaches exactly the responder the call did.
interface RpcCall { "id": string; "replyTo": string; "args"?: unknown; "cancel"?: true }
interface RpcReply { "id": string; "result"?: unknown; "error"?: string }
interface Pending { "resolve": (value: unknown) => void; "reject": (error: Error) => void; "timer"?: ReturnType<typeof setTimeout>; "cleanup"?: () => void }

function isRpcReply(value: unknown): value is RpcReply {
	return typeof value === "object" && value !== null && typeof (value as RpcReply).id === "string";
}

function isRpcCall(value: unknown): value is RpcCall {
	const call = value as RpcCall | null;

	return typeof value === "object" && value !== null && typeof call!.id === "string" && typeof call!.replyTo === "string";
}

export interface RpcRequestOptions {
	/** Reject after this long (default 15s). `Infinity` = never — for a caller that owns cancellation via `signal`. */
	"timeoutMs"?: number;
	/** Wait up to this long for a responder's interest to reach this hub (a link still coming up) and reject with a
	 *  "no responder" error if none does, instead of publishing into nothing and waiting out the whole timeout. */
	"waitForResponderMs"?: number;
	/** Aborting rejects the call with `signal.reason` and tells the responder, whose handler sees its own signal
	 *  abort (see `serve`) — so a long-running call can stop work nobody will read. */
	"signal"?: AbortSignal;
}

export interface RpcClient {
	/** Call `name` on whatever hub serves it and await the reply. Rejects on timeout, abort, or a served error. If
	 *  nothing serves `name`, the request goes nowhere and the call times out (see `waitForResponderMs`). */
	"request": (name: string, args?: unknown, options?: RpcRequestOptions) => Promise<unknown>;
	/** Stop listening for replies, and reject the calls still waiting on one. */
	"dispose": () => void;
}

/** `promise`, or `signal.reason` as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) {
		return promise;
	}

	return new Promise((resolve, reject) => {
		const onAbort = (): void => { reject(signal.reason); };

		signal.addEventListener("abort", onAbort, { "once": true });
		promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", onAbort); });
	});
}

/** Make a request client on `hub`. Subscribes the reply channel immediately, so by the time a responder links in
 *  it already knows this hub wants its replies (the `hello` re-advertise carries it) — the call itself never races
 *  interest. One client per hub is plenty; each call is correlated by id. */
export function createRpcClient(hub: Hub): RpcClient {
	const pending = new Map<string, Pending>();
	// Replies come to who we are to the responder (serve replies to the call's `from`): our own id — or, past an edge
	// that assigned us one (our uplink's hello says so: Hub.knownAs), that one, the only reply subject the edge lets
	// through to us. Listen on each, as it's learned. (`replyTo` declares our own id, for a responder that reads it.)
	const listening = new Map<string, () => void>();
	const replyTo = (): string => hub.id;
	const listen = (id: string): void => {
		if (!listening.has(id)) {
			listening.set(id, hub.subscribe(RPC_REPLY + "." + id, onReply));
		}
	};

	function onReply(data: unknown): void {
		if (!isRpcReply(data)) {
			return;
		}

		const entry = pending.get(data.id);

		if (entry === undefined) {
			return;
		}

		pending.delete(data.id);
		entry.cleanup?.();

		if (data.error !== undefined) {
			entry.reject(new Error(data.error));
		} else {
			entry.resolve(data.result);
		}
	}

	listen(hub.id);

	for (const id of hub.knownAs()) {
		listen(id);
	}

	const untap = hub.tap((event) => {
		if (event.type === "topology") {
			for (const id of hub.knownAs()) {
				listen(id);
			}
		}
	});

	return {
		"request": async (name, args, options = {}) => {
			const { signal } = options;

			signal?.throwIfAborted();

			if (options.waitForResponderMs !== undefined && !(await raceAbort(hub.whenInterested(RPC_CALL + "." + name, options.waitForResponderMs), signal))) {
				throw new Error(`rpc "${name}": no responder within ${options.waitForResponderMs}ms`);
			}

			return call(name, args, options.timeoutMs, signal);
		},
		"dispose": () => {
			untap();

			for (const unsubscribe of listening.values()) {
				unsubscribe();
			}

			listening.clear();

			for (const [id, entry] of pending) {
				pending.delete(id);
				entry.cleanup?.();
				entry.reject(new Error("rpc client disposed"));
			}
		}
	};

	function call(name: string, args: unknown, timeoutMs = 15000, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
			const entry: Pending = { "resolve": resolve, "reject": reject };
			const onAbort = (): void => {
				pending.delete(id);
				entry.cleanup?.();
				hub.publish(RPC_CALL + "." + name, { "id": id, "replyTo": replyTo(), "cancel": true } satisfies RpcCall);
				reject(signal!.reason);
			};

			if (Number.isFinite(timeoutMs)) {
				entry.timer = setTimeout(() => {
					pending.delete(id);
					entry.cleanup?.();
					reject(new Error(`rpc "${name}" timed out after ${timeoutMs}ms (no responder?)`));
				}, timeoutMs);
			}

			entry.cleanup = () => {
				clearTimeout(entry.timer);
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort, { "once": true });
			pending.set(id, entry);
			hub.publish(RPC_CALL + "." + name, { "id": id, "replyTo": replyTo(), "args": args } satisfies RpcCall);
		});
	}
}

/** Serve request `name` on `hub`: run `handler` for each call and publish its result (or error) back to the
 *  caller. Returns an unsubscribe. The handler's return value must be structured-clonable / JSON-safe (it may
 *  cross a WebSocket). This is how a browser tab HOSTS a tool — `serve(hub, "page_eval", …)`. The handler's
 *  `signal` aborts when the caller cancels; a cancelled call sends no reply (the caller has already moved on). */
export interface ServeContext {
	/** Aborts when the caller cancels. */
	"signal": AbortSignal;
	/** The caller's hub id — authenticated when an edge hub assigned it (LinkOptions.peer), the caller's claim
	 *  otherwise. */
	"from"?: string;
	/** The adjacent link the call arrived on (undefined for a call made on this hub). */
	"link"?: LinkInfo;
}

export function serve(hub: Hub, name: string, handler: (args: unknown, context: ServeContext) => unknown): () => void {
	// In-flight calls by caller + id, so a cancel finds its call's controller.
	const inFlight = new Map<string, AbortController>();

	return hub.subscribe(RPC_CALL + "." + name, (data, envelope, origin) => {
		if (!isRpcCall(data)) {
			return;
		}

		// Reply to who the caller IS — its `from`, stamped by the edge that assigned its id, or its own id where no edge
		// did — not to the address it declares: an edge lets an assigned peer receive only `$rpc.reply.<assigned>`, and
		// the caller listens on its own id and on the one its uplink gave it. (`replyTo` for a caller without a `from`.)
		const { id, args } = data;
		const replyTo = envelope.from ?? data.replyTo;
		const key = replyTo + " " + id;

		if (data.cancel === true) {
			inFlight.get(key)?.abort();

			return;
		}

		const controller = new AbortController();

		inFlight.set(key, controller);

		void (async () => {
			try {
				const result = await handler(args, { "signal": controller.signal, "from": envelope.from, "link": origin.link });

				if (!controller.signal.aborted) {
					hub.publish(RPC_REPLY + "." + replyTo, { "id": id, "result": result } satisfies RpcReply);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					hub.publish(RPC_REPLY + "." + replyTo, { "id": id, "error": error instanceof Error ? error.message : String(error) } satisfies RpcReply);
				}
			} finally {
				inFlight.delete(key);
			}
		})();
	});
}
