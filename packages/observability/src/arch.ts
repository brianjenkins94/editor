/**
 * The architecture plane: every context reports its own place in the editor's topology — its hub's links (and the
 * hub at the other end of each), the traffic crossing them, and the non-hub channels its probes observe (workers,
 * extension hosts, webviews, network, storage) — on `$sys.arch.<reporter>`. Like `$sys.log`, it federates up the
 * hub tree to whoever subscribes (the live architecture view, debug-mcp), and stays local when nobody does.
 *
 * A reporter never draws anything: it batches (so observing traffic doesn't flood the bus with more traffic) and
 * answers `$sys.arch.sync` with its full state, so a viewer opened late still sees what already happened.
 */
import type { Envelope, Hub, HubSnapshot, TapEvent } from "@brianjenkins94/hub";

/** Reserved architecture namespace — reports ride `$sys.arch.<reporter id>`; `$sys.arch.sync` asks for full state. */
export const ARCH_SUBJECT = "$sys.arch";
const SYNC_SUBJECT = ARCH_SUBJECT + ".sync";

export type TrafficKind = "request" | "reply" | "error" | "event" | "message" | "ack" | "cancel" | "lifecycle";
export type NodeState = "declared" | "alive" | "unresponsive" | "terminated";

/** A runtime context (a hub, a worker, an extension host, a webview, a network endpoint…). Only `id` is required:
 *  the viewer's declared model knows how to label, place and describe the ids it expects. */
export interface ArchNodeSpec {
	"id": string;
	"role"?: string;
	"label"?: string;
	"container"?: string;
	"detail"?: string;
	/** Created at runtime (webviews, nested workers…): hidden a while after it ends. */
	"dynamic"?: boolean;
	"meta"?: Record<string, string>;
}

export type NodeOp =
	| { "op": "declare" | "spawn"; "spec": ArchNodeSpec }
	| { "op": "terminate"; "id": string }
	| { "op": "state"; "id": string; "state": NodeState };

/** Aggregated traffic between two nodes since the previous report (or, in a sync, since the reporter started). */
export interface TrafficCount {
	"from": string;
	"to": string;
	"kind": TrafficKind;
	"label": string;
	"count": number;
	"bytes": number;
	/** Carried by the hub (the label is then a subject) rather than observed by a probe. */
	"via"?: "hub";
}

/** One observed message, sampled for the log and the animation (counts come from `traffic`, not from samples).
 *  `payload` is what it carried — a preview, size-capped — only while a viewer has payload capture on. */
export interface TrafficSample { "t": number; "from": string; "to": string; "kind": TrafficKind; "label": string; "bytes": number; "via"?: "hub"; "payload"?: string }

export interface ArchReport {
	"reporter": string;
	/** `Date.now()` on the reporter — comparable across realms, unlike `performance.now()`. */
	"time": number;
	/** A full-state answer to `$sys.arch.sync`: `traffic` holds totals rather than deltas. */
	"full"?: boolean;
	/** Where the reporting hub runs (sent with its topology): so a viewer can place a context it doesn't know. */
	"realm"?: ArchRealm;
	"topology"?: HubSnapshot;
	"nodes"?: NodeOp[];
	"traffic"?: TrafficCount[];
	"samples"?: TrafficSample[];
	/** The reporter's page is going (pagehide): its last word. A viewer takes it as ended — until it reports again (a
	 *  reloaded page, under the same id). Only a window can say so; a worker ends with its page, silently. */
	"ended"?: true;
}

/** Where a hub runs: a window (a page or a frame — `parent` is its parent frame's address, when it has a same-origin
 *  one) or a worker (`url` is its script; `parent`, the address of the realm that spawned it, when it was told —
 *  REALM_PARENT). */
export interface ArchRealm {
	"kind": "window" | "worker";
	"url": string;
	"parent"?: string;
}

/** This realm, or undefined outside a browser (Node — debug-mcp, tests). */
export function describeRealm(): ArchRealm | undefined {
	const scope = globalThis as { "window"?: Window; "location"?: Location; "importScripts"?: unknown };

	if (scope.location === undefined) {
		return undefined;
	}

	if (scope.window === undefined) {
		if (typeof scope.importScripts !== "function") {
			return undefined;
		}

		const url = new URL(scope.location.href);
		const parent = new URLSearchParams(url.hash.slice(1)).get(REALM_PARENT);

		url.hash = "";

		return { "kind": "worker", "url": url.href, ...parent === null ? {} : { "parent": parent } };
	}

	const realm: ArchRealm = { "kind": "window", "url": scope.location.href };

	try {
		if (scope.window.parent !== scope.window) {
			realm.parent = scope.window.parent.location.href;
		}
	} catch { /* a cross-origin parent: unknown */ }

	return realm;
}

/** What probes feed. `self` is the node id of the reporting context (its hub id). */
export interface ArchSink {
	readonly "self": string;
	"declare": (spec: ArchNodeSpec) => void;
	"spawn": (spec: ArchNodeSpec) => void;
	"terminate": (id: string) => void;
	"state": (id: string, state: NodeState) => void;
	/** `count` messages of `bytes` in total (a probe that aggregates before reporting); default one. */
	/** Count a message (or `count` of them) from → to. `payload` is what it carried: kept, as a preview, only while
	 *  payload capture is on (see requestArchSync). */
	"record": (from: string, to: string, kind: TrafficKind, label: string, bytes?: number, count?: number, payload?: unknown) => void;
}

export interface ArchReporter extends ArchSink {
	"dispose": () => void;
}

const FLUSH_MS = 250;
/** A reporter with nothing new still reports this often while someone listens — so a viewer can tell a quiet context
 *  from a gone one (SILENCE_MS). */
const HEARTBEAT_MS = 5000;
/** How long a viewer waits on a reporter's silence before taking it as gone: a few missed heartbeats. */
export const SILENCE_MS = 15_000;
/** A worker's realm parent, in its URL's hash (`#realm-parent=<address>`): who spawned it — set by whoever wraps
 *  `Worker` there (the editor's preview tap), and read by the worker's reporter (describeRealm). */
export const REALM_PARENT = "realm-parent";
const MAX_SAMPLES_PER_FLUSH = 120;
/** Node ops held while nobody listens (see flush), past which they're collapsed into the nodes' current state. */
const MAX_HELD_NODE_OPS = 200;

/** Cheap estimate of a structured-cloned value's size — good enough to compare channels, never exact. */
export function approxSize(value: unknown, depth = 0): number {
	if (value === null || value === undefined) {
		return 0;
	}

	switch (typeof value) {
		case "string":
			return value.length;
		case "number":
		case "bigint":
			return 8;
		case "boolean":
			return 1;
		case "object":
			break;
		default:
			return 0;
	}

	if (value instanceof ArrayBuffer) {
		return value.byteLength;
	}

	if (ArrayBuffer.isView(value)) {
		return value.byteLength;
	}

	if (depth > 5) {
		return 0;
	}

	let size = 0;

	if (Array.isArray(value)) {
		for (const item of value) {
			size += approxSize(item, depth + 1);
		}

		return size;
	}

	for (const [key, item] of Object.entries(value)) {
		size += key.length + approxSize(item, depth + 1);
	}

	return size;
}

/** `node.out.12` → `node.out.*`: ids in subjects (and in RPC names) would make every run a new label. An id is a
 *  number, a UUID, 8+ hex digits, or 12+ lowercase letters and digits with at least one digit (a word isn't). */
export function normalizeSubject(subject: string): string {
	return subject
		.split(".")
		.map((token) => ((/^\d+$|^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$|^[\da-f]{8,}$|^(?=[a-z]*\d)[\da-z]{12,}$/u).test(token) ? "*" : token))
		.join(".");
}

// hub's RPC subjects (its rpcCallSubject / rpcReplySubject) — spelled out: this package tests against hub's
// published release, which a new hub export reaches only after this package's CI passes.
const RPC_CALL = "$rpc.call.";
const RPC_REPLY = "$rpc.reply.";

/**
 * Create the reporter for the context `hub` lives in: taps the hub (its topology, and every message it SENDS on a
 * link — each hop has exactly one sender, so nothing is counted twice) and gives probes an `ArchSink` for the
 * channels the hub doesn't carry. Reports are batched every 250ms, published only when something changed — and at
 * least every few seconds while someone listens (a heartbeat: SILENCE_MS).
 *
 * It reports under its hub's id; the edge it joins another tree through renames it there (scope.ts).
 */
export function createArchReporter(hub: Hub): ArchReporter {
	const self = hub.id;
	const realm = describeRealm();
	const counts = new Map<string, TrafficCount>();
	const totals = new Map<string, TrafficCount>();
	const nodes = new Map<string, { "spec": ArchNodeSpec; "state": NodeState; "alive": number }>();
	let nodeOps: NodeOp[] = [];
	let samples: TrafficSample[] = [];
	let topologyDirty = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	// rpc call id → name, to label the replies
	const rpcNames = new Map<string, string>();
	// Payload capture (a viewer's opt-in, via requestArchSync): samples keep what each message carried.
	let capturing = false;
	// A hub sends its interest before its hello, so a call can go out on a link whose peer hasn't said who it is yet (a
	// worker's first request at boot). Held by link until the hello names it; dropped if the link goes first.
	const unnamed = new Map<string, { "kind": TrafficKind; "label": string; "bytes": number; "payload"?: unknown }[]>();

	function nameHeldTraffic(): void {
		const links = new Map(hub.inspect().links.map((link) => [link.id, link.peerId]));

		for (const [link, held] of unnamed) {
			const peer = links.get(link);

			if (peer !== undefined) {
				for (const { kind, label, bytes, payload } of held) {
					record(self, peer, kind, label, bytes, "hub", 1, payload);
				}
			}

			if (peer !== undefined || !links.has(link)) {
				unnamed.delete(link);
			}
		}
	}

	let lastPublished = 0;
	// Nothing new for a while, and someone listening: say so (see SILENCE_MS).
	const heartbeat = setInterval(() => {
		if (!disposed && timer === undefined && Date.now() - lastPublished >= HEARTBEAT_MS && hub.interested(ARCH_SUBJECT + "." + self)) {
			publish({ "reporter": self, "time": Date.now() });
		}
	}, HEARTBEAT_MS);

	(heartbeat as { "unref"?: () => void }).unref?.(); // (Node: never what keeps a process alive)

	function schedule(): void {
		if (timer === undefined && !disposed) {
			timer = setTimeout(flush, FLUSH_MS);
		}
	}

	function publish(report: ArchReport): void {
		lastPublished = Date.now();

		try {
			hub.publish(ARCH_SUBJECT + "." + self, report);
		} catch { /* telemetry must never break the context it observes */ }
	}

	function flush(): void {
		timer = undefined;

		if (counts.size === 0 && nodeOps.length === 0 && samples.length === 0 && !topologyDirty) {
			return;
		}

		// Nobody's listening yet — a viewer's interest hasn't reached this hub (it's booting, or the link that carries
		// it is): a report published now would go nowhere, and with it what nothing re-sends by itself (the realm, the
		// traffic so far). Hold it. The interest's arrival is a topology change, which flushes again.
		if (!hub.interested(ARCH_SUBJECT + "." + self)) {
			if (nodeOps.length > MAX_HELD_NODE_OPS) {
				nodeOps = currentNodeOps();
			}

			return;
		}

		const report: ArchReport = { "reporter": self, "time": Date.now() };

		if (topologyDirty) {
			report.topology = hub.inspect();
			report.realm = realm;
			topologyDirty = false;
		}

		if (nodeOps.length > 0) {
			report.nodes = nodeOps;
			nodeOps = [];
		}

		if (counts.size > 0) {
			report.traffic = [...counts.values()];
			counts.clear();
		}

		if (samples.length > 0) {
			report.samples = samples;
			samples = [];
		}

		publish(report);
	}

	function keyOf(entry: Omit<TrafficCount, "count" | "bytes">): string {
		return entry.from + "\0" + entry.to + "\0" + entry.kind + "\0" + entry.label + "\0" + (entry.via ?? "");
	}

	function add(map: Map<string, TrafficCount>, entry: TrafficCount): void {
		const key = keyOf(entry);
		const existing = map.get(key);

		if (existing === undefined) {
			map.set(key, { ...entry });
		} else {
			existing.count += entry.count;
			existing.bytes += entry.bytes;
		}
	}

	/** The nodes this reporter knows, as the ops that bring a viewer to their current state. */
	function currentNodeOps(): NodeOp[] {
		return [...nodes.values()].flatMap(({ spec, state, alive }): NodeOp[] => {
			const ops: NodeOp[] = [{ "op": alive > 0 ? "spawn" : "declare", "spec": spec }];

			if (state === "terminated" || state === "unresponsive") {
				ops.push(state === "terminated" ? { "op": "terminate", "id": spec.id } : { "op": "state", "id": spec.id, "state": state });
			}

			return ops;
		});
	}

	function record(from: string, to: string, kind: TrafficKind, label: string, bytes = 0, via?: "hub", count = 1, payload?: unknown): void {
		const entry: TrafficCount = { "from": from, "to": to, "kind": kind, "label": label, "count": count, "bytes": bytes };

		if (via !== undefined) {
			entry.via = via;
		}

		add(counts, entry);
		add(totals, entry);

		if (samples.length < MAX_SAMPLES_PER_FLUSH) {
			samples.push({ "t": Date.now(), "from": from, "to": to, "kind": kind, "label": label, "bytes": bytes, "via": via, ...capturing && payload !== undefined ? { "payload": previewPayload(payload) } : {} });
		}

		schedule();
	}

	function nodeOp(op: NodeOp): void {
		nodeOps.push(op);
		schedule();
	}

	/** Describe a hub envelope the way the diagram labels it: RPC by method, replies after their call. */
	function describe(envelope: Envelope): { "kind": TrafficKind; "label": string } {
		const { subject, data } = envelope;

		if (subject.startsWith(RPC_CALL)) {
			const name = normalizeSubject(subject.slice(RPC_CALL.length));
			const id = (data as { "id"?: unknown } | undefined)?.id;

			if (typeof id === "string") {
				rpcNames.set(id, name);
			}

			return { "kind": "request", "label": name + "()" };
		}

		if (subject.startsWith(RPC_REPLY)) {
			const reply = data as { "id"?: unknown; "error"?: unknown } | undefined;
			const name = typeof reply?.id === "string" ? rpcNames.get(reply.id) : undefined;

			if (typeof reply?.id === "string") {
				rpcNames.delete(reply.id);
			}

			return { "kind": reply?.error === undefined ? "reply" : "error", "label": "↩ " + (name ?? "rpc") + "()" };
		}

		return { "kind": subject.startsWith("$sys.log") ? "event" : "message", "label": normalizeSubject(subject) };
	}

	const disposeTap = hub.tap((event: TapEvent) => {
		switch (event.type) {
			case "topology":
				topologyDirty = true;
				nameHeldTraffic();
				schedule();
				break;
			case "send": {
				const { frame } = event;

				// Our own reports (and everyone's, passing through) are the observer, not the observed.
				if (!("hub" in frame) && frame.subject.startsWith(ARCH_SUBJECT)) {
					return;
				}

				const { kind, label } = "hub" in frame ? { "kind": "lifecycle" as const, "label": frame.hub === "hello" ? "hello" : "interest (" + frame.hub + ")" } : describe(frame);
				const bytes = "hub" in frame ? 0 : approxSize(frame.data);
				const payload = "hub" in frame ? undefined : frame.data;
				const peer = event.link.peerId;

				if (peer !== undefined) {
					record(self, peer, kind, label, bytes, "hub", 1, payload);
				} else if ((unnamed.get(event.link.id)?.length ?? 0) < MAX_SAMPLES_PER_FLUSH) {
					unnamed.set(event.link.id, [...unnamed.get(event.link.id) ?? [], { "kind": kind, "label": label, "bytes": bytes, "payload": payload }]);
				}

				break;
			}

			case "receive": {
				// Replies are labelled from the call we saw going out; learn calls arriving too.
				const { frame } = event;

				if (!("hub" in frame) && frame.subject.startsWith(RPC_CALL)) {
					const id = (frame.data as { "id"?: unknown } | undefined)?.id;

					if (typeof id === "string") {
						rpcNames.set(id, normalizeSubject(frame.subject.slice(RPC_CALL.length)));
					}
				}

				break;
			}

			default:
				break;
		}
	});

	// A viewer opened late asks everyone for their full state.
	const disposeSync = hub.subscribe(SYNC_SUBJECT, (data) => {
		const capture = (data as { "capture"?: unknown } | undefined)?.capture;

		if (typeof capture === "boolean") {
			capturing = capture;
		}

		setTimeout(() => {
			// Deltas still pending are part of the totals below: send them FIRST so they reach a viewer before the
			// full state (which then replaces this reporter's counts) — never after it, where they'd count twice.
			if (timer !== undefined) {
				clearTimeout(timer);
			}

			flush();
			publish({
				"reporter": self,
				"time": Date.now(),
				"full": true,
				"topology": hub.inspect(),
				"realm": realm,
				"nodes": currentNodeOps(),
				"traffic": [...totals.values()]
			});
		}, 0);
	});


	// A page that goes says so — a viewer would otherwise keep its hubs as if alive (a navigated preview window, a
	// reloaded frame). Sent as it goes: the links carry it synchronously (a window's postMessage, a port's).
	const onPagehide = (): void => { publish({ "reporter": self, "time": Date.now(), "ended": true }); };
	const target = globalThis as { "addEventListener"?: (type: string, handler: () => void) => void; "removeEventListener"?: (type: string, handler: () => void) => void };

	if (realm?.kind === "window") {
		target.addEventListener?.("pagehide", onPagehide);
	}

	const disposePagehide = (): void => { target.removeEventListener?.("pagehide", onPagehide); };

	return {
		"self": self,
		"declare": (spec) => {
			const entry = nodes.get(spec.id);

			if (entry === undefined) {
				nodes.set(spec.id, { "spec": spec, "state": "declared", "alive": 0 });
			} else {
				entry.spec = { ...entry.spec, ...spec }; // a re-declare updates the spec (a gauge in `meta`)
			}

			nodeOp({ "op": "declare", "spec": spec });
		},
		"spawn": (spec) => {
			const entry = nodes.get(spec.id) ?? { "spec": spec, "state": "declared" as NodeState, "alive": 0 };

			entry.spec = { ...entry.spec, ...spec };
			entry.alive += 1;
			entry.state = "alive";
			nodes.set(spec.id, entry);
			nodeOp({ "op": "spawn", "spec": spec });
		},
		"terminate": (id) => {
			const entry = nodes.get(id);

			if (entry !== undefined) {
				entry.alive = Math.max(0, entry.alive - 1);

				if (entry.alive === 0) {
					entry.state = "terminated";
				}
			}

			nodeOp({ "op": "terminate", "id": id });
		},
		"state": (id, state) => {
			const entry = nodes.get(id);

			if (entry !== undefined) {
				entry.state = state;
			}

			nodeOp({ "op": "state", "id": id, "state": state });
		},
		"record": (from, to, kind, label, bytes, count, payload) => { record(from, to, kind, label, bytes, undefined, count, payload); },
		"dispose": () => {
			disposed = true;
			clearInterval(heartbeat);
			disposeTap();
			disposeSync();
			disposePagehide();

			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	};
}

/**
 * Ask every reporter in the tree for its full state (a viewer does this when it opens). `capture` turns payload capture
 * on or off everywhere: while on, each sampled message keeps a size-capped preview of what it carried (opt-in — it
 * records app data). Left out, each reporter keeps its setting.
 */
export function requestArchSync(hub: Hub, { capture }: { "capture"?: boolean } = {}): void {
	hub.publish(SYNC_SUBJECT, capture === undefined ? undefined : { "capture": capture });
}

/** How much of a captured payload a sample keeps. */
export const PAYLOAD_PREVIEW_CHARS = 1000;

/** A message's payload as a sample keeps it: JSON (binary as its size), size-capped. */
export function previewPayload(value: unknown, max = PAYLOAD_PREVIEW_CHARS): string {
	let text: string;

	try {
		text = typeof value === "string" ? value : JSON.stringify(value, (_key, item: unknown) => {
			if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
				return `<${item.constructor.name} ${item.byteLength} bytes>`;
			}

			if (typeof item === "bigint") {
				return String(item) + "n";
			}

			return item;
		}) ?? String(value);
	} catch {
		text = String(value);
	}

	return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Subscribe to every reporter's reports. */
export function collectArchReports(hub: Hub, onReport: (report: ArchReport) => void): () => void {
	return hub.subscribe(ARCH_SUBJECT + ".>", (data, envelope) => {
		if (envelope.subject !== SYNC_SUBJECT) {
			onReport(data as ArchReport);
		}
	});
}
