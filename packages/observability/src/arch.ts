/**
 * The architecture plane: every context reports its own place in the editor's topology — its hub's links (and the
 * hub at the other end of each), the traffic crossing them, and the non-hub channels its probes observe (workers,
 * extension hosts, webviews, network, storage) — on `$sys.arch.<reporter>`. Like `$sys.log`, it federates up the
 * hub tree to whoever subscribes (the live architecture view, debug-mcp), and stays local when nobody does.
 *
 * A reporter never draws anything: it batches (so observing traffic doesn't flood the bus with more traffic) and
 * answers `$sys.arch.sync` with its full state, so a viewer opened late still sees what already happened.
 */
import type { Envelope, Hub, HubSnapshot, LinkInfo, TapEvent } from "@brianjenkins94/hub";

/** Reserved architecture namespace — reports ride `$sys.arch.<reporter id>`; `$sys.arch.sync` asks for full state. */
export const ARCH_SUBJECT = "$sys.arch";
const SYNC_SUBJECT = ARCH_SUBJECT + ".sync";

export type TrafficKind = "request" | "reply" | "error" | "event" | "message" | "ack" | "cancel" | "lifecycle" | "transport";
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
export interface TrafficCount { "from": string; "to": string; "kind": TrafficKind; "label": string; "count": number; "bytes": number }

/** One observed message, sampled for the log and the animation (counts come from `traffic`, not from samples). */
export interface TrafficSample { "t": number; "from": string; "to": string; "kind": TrafficKind; "label": string; "bytes": number }

export interface ArchReport {
	"reporter": string;
	/** `Date.now()` on the reporter — comparable across realms, unlike `performance.now()`. */
	"time": number;
	/** A full-state answer to `$sys.arch.sync`: `traffic` holds totals rather than deltas. */
	"full"?: boolean;
	"topology"?: HubSnapshot;
	"nodes"?: NodeOp[];
	"traffic"?: TrafficCount[];
	"samples"?: TrafficSample[];
}

/** What probes feed. `self` is the node id of the reporting context (its hub id). */
export interface ArchSink {
	readonly "self": string;
	"declare": (spec: ArchNodeSpec) => void;
	"spawn": (spec: ArchNodeSpec) => void;
	"terminate": (id: string) => void;
	"state": (id: string, state: NodeState) => void;
	"record": (from: string, to: string, kind: TrafficKind, label: string, bytes?: number) => void;
}

export interface ArchReporter extends ArchSink {
	"dispose": () => void;
}

const FLUSH_MS = 250;
const MAX_SAMPLES_PER_FLUSH = 120;

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

/** `node.out.12` → `node.out.*`: ids in subjects would make every run a new label. */
function normalizeSubject(subject: string): string {
	return subject
		.split(".")
		.map((token) => (/^\d+$|^[\da-f]{8,}$|^[\da-z]{12,}$/u).test(token) ? "*" : token)
		.join(".");
}

const RPC_CALL = "$rpc.call.";
const RPC_REPLY = "$rpc.reply.";

/**
 * Create the reporter for the context `hub` lives in: taps the hub (its topology, and every message it SENDS on a
 * link — each hop has exactly one sender, so nothing is counted twice) and gives probes an `ArchSink` for the
 * channels the hub doesn't carry. Reports are batched every 250ms, published only when something changed.
 */
export function createArchReporter(hub: Hub): ArchReporter {
	const self = hub.id;
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

	function schedule(): void {
		if (timer === undefined && !disposed) {
			timer = setTimeout(flush, FLUSH_MS);
		}
	}

	function publish(report: ArchReport): void {
		try {
			hub.publish(ARCH_SUBJECT + "." + self, report);
		} catch { /* telemetry must never break the context it observes */ }
	}

	function flush(): void {
		timer = undefined;

		if (counts.size === 0 && nodeOps.length === 0 && samples.length === 0 && !topologyDirty) {
			return;
		}

		const report: ArchReport = { "reporter": self, "time": Date.now() };

		if (topologyDirty) {
			report.topology = hub.inspect();
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

	function record(from: string, to: string, kind: TrafficKind, label: string, bytes = 0): void {
		const key = from + "\0" + to + "\0" + kind + "\0" + label;

		for (const map of [counts, totals]) {
			const entry = map.get(key);

			if (entry === undefined) {
				map.set(key, { "from": from, "to": to, "kind": kind, "label": label, "count": 1, "bytes": bytes });
			} else {
				entry.count += 1;
				entry.bytes += bytes;
			}
		}

		if (samples.length < MAX_SAMPLES_PER_FLUSH) {
			samples.push({ "t": Date.now(), "from": from, "to": to, "kind": kind, "label": label, "bytes": bytes });
		}

		schedule();
	}

	function nodeOp(op: NodeOp): void {
		nodeOps.push(op);
		schedule();
	}

	function peerOf(link: LinkInfo): string {
		return link.peerId ?? self + ":" + link.id;
	}

	/** Describe a hub envelope the way the diagram labels it: RPC by method, replies after their call. */
	function describe(envelope: Envelope): { "kind": TrafficKind; "label": string } {
		const { subject, data } = envelope;

		if (subject.startsWith(RPC_CALL)) {
			const name = subject.slice(RPC_CALL.length);
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
				schedule();
				break;
			case "send": {
				const { frame } = event;

				if (!("hub" in frame)) {
					// Our own reports (and everyone's, passing through) are the observer, not the observed.
					if (frame.subject.startsWith(ARCH_SUBJECT)) {
						return;
					}

					const { kind, label } = describe(frame);

					record(self, peerOf(event.link), kind, label, approxSize(frame.data));
				} else {
					record(self, peerOf(event.link), "lifecycle", frame.hub === "hello" ? "hello" : "interest (" + frame.hub + ")");
				}

				break;
			}
			case "receive": {
				// Replies are labelled from the call we saw going out; learn calls arriving too.
				const { frame } = event;

				if (!("hub" in frame) && frame.subject.startsWith(RPC_CALL)) {
					const id = (frame.data as { "id"?: unknown } | undefined)?.id;

					if (typeof id === "string") {
						rpcNames.set(id, frame.subject.slice(RPC_CALL.length));
					}
				}

				break;
			}
			default:
				break;
		}
	});

	// A viewer opened late asks everyone for their full state.
	const disposeSync = hub.subscribe(SYNC_SUBJECT, () => {
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
				"nodes": [...nodes.values()].flatMap(({ spec, state, alive }): NodeOp[] => {
					const ops: NodeOp[] = [{ "op": alive > 0 ? "spawn" : "declare", "spec": spec }];

					if (state === "terminated" || state === "unresponsive") {
						ops.push(state === "terminated" ? { "op": "terminate", "id": spec.id } : { "op": "state", "id": spec.id, "state": state });
					}

					return ops;
				}),
				"traffic": [...totals.values()]
			});
		}, 0);
	});

	return {
		self,
		"declare": (spec) => {
			if (!nodes.has(spec.id)) {
				nodes.set(spec.id, { "spec": spec, "state": "declared", "alive": 0 });
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
		record,
		"dispose": () => {
			disposed = true;
			disposeTap();
			disposeSync();

			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	};
}

/** Ask every reporter in the tree for its full state (a viewer does this when it opens). */
export function requestArchSync(hub: Hub): void {
	hub.publish(SYNC_SUBJECT);
}

/** Subscribe to every reporter's reports. */
export function collectArchReports(hub: Hub, onReport: (report: ArchReport) => void): () => void {
	return hub.subscribe(ARCH_SUBJECT + ".>", (data, envelope) => {
		if (envelope.subject !== SYNC_SUBJECT) {
			onReport(data as ArchReport);
		}
	});
}
