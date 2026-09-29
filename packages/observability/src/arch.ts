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

/** One observed message, sampled for the log and the animation (counts come from `traffic`, not from samples). */
export interface TrafficSample { "t": number; "from": string; "to": string; "kind": TrafficKind; "label": string; "bytes": number; "via"?: "hub" }

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
	/** `count` messages of `bytes` in total (a probe that aggregates before reporting); default one. */
	"record": (from: string, to: string, kind: TrafficKind, label: string, bytes?: number, count?: number) => void;
}

export interface ArchReporter extends ArchSink {
	"dispose": () => void;
}

const FLUSH_MS = 250;
// A link whose peer isn't known yet (its `hello` hasn't arrived — the peer may still be booting): its traffic is
// held back until the peer says who it is. A peer whose `hello` carries no id (an older hub), or a link that closed
// first, is published as `<self>:<link id>`.
const PENDING_LINK = "\0link:";
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

/** `node.out.12` → `node.out.*`: ids in subjects (and in RPC names) would make every run a new label. An id is a
 *  number, a UUID, 8+ hex digits, or 12+ lowercase letters and digits with at least one digit (a word isn't). */
export function normalizeSubject(subject: string): string {
	return subject
		.split(".")
		.map((token) => ((/^\d+$|^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$|^[\da-f]{8,}$|^(?=[a-z]*\d)[\da-z]{12,}$/u).test(token) ? "*" : token))
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
	// links whose peer said hello WITHOUT an id: they'll stay anonymous
	const anonymousLinks = new Set<string>();
	// every peer a hello named, by link — so a short-lived link (a worker done before the next flush) still resolves
	const knownPeers = new Map<string, string>();
	// placeholders already reported as ended (a link gone before its peer answered)
	const endedPlaceholders = new Set<string>();

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

		resolvePendingLinks();

		const report: ArchReport = { "reporter": self, "time": Date.now() };

		if (topologyDirty) {
			report.topology = hub.inspect();
			topologyDirty = false;
		}

		if (nodeOps.length > 0) {
			report.nodes = nodeOps;
			nodeOps = [];
		}

		// Traffic on links still waiting for their peer's `hello` waits for the next flush.
		const ready = [...counts].filter(([, entry]) => !isPending(entry));

		if (ready.length > 0) {
			report.traffic = ready.map(([, entry]) => entry);

			for (const [key] of ready) {
				counts.delete(key);
			}
		}

		const readySamples = samples.filter((sample) => !isPending(sample));

		if (readySamples.length > 0) {
			report.samples = readySamples;
		}

		// (only the latest few: a peer can take seconds to boot, and samples are for the animation, not the counts)
		samples = samples.filter((sample) => isPending(sample)).slice(-40);

		if (counts.size > 0 || samples.length > 0) {
			schedule();
		}

		publish(report);
	}

	function isPending(entry: { "from": string; "to": string }): boolean {
		return entry.from.startsWith(PENDING_LINK) || entry.to.startsWith(PENDING_LINK);
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

	function record(from: string, to: string, kind: TrafficKind, label: string, bytes = 0, via?: "hub", count = 1): void {
		const entry: TrafficCount = { "from": from, "to": to, "kind": kind, "label": label, "count": count, "bytes": bytes };

		if (via !== undefined) {
			entry.via = via;
		}

		add(counts, entry);
		add(totals, entry);

		if (samples.length < MAX_SAMPLES_PER_FLUSH) {
			samples.push({ "t": Date.now(), "from": from, "to": to, "kind": kind, "label": label, "bytes": bytes, "via": via });
		}

		schedule();
	}

	/** Name the peers of links whose `hello` arrived since their traffic was recorded. A peer that said hello
	 *  without an id, or a link that's gone, is named `<self>:<link id>`; otherwise the traffic stays pending. A link
	 *  gone before its peer ever answered is reported as a context that ENDED (dynamic, terminated): it can live and die
	 *  between two reports — a tab re-linking to a service worker that was replaced mid-boot — so no topology report
	 *  ever shows it, and without this its placeholder would look alive forever. */
	function resolvePendingLinks(): void {
		const links = new Map(hub.inspect().links.map((link) => [PENDING_LINK + link.id, link.peerId]));
		const resolve = (id: string): string => {
			if (!id.startsWith(PENDING_LINK)) {
				return id;
			}

			const peer = links.get(id) ?? knownPeers.get(id);

			if (peer !== undefined) {
				return peer;
			}

			if (!links.has(id) || anonymousLinks.has(id)) {
				const named = self + ":" + id.slice(PENDING_LINK.length);

				if (!links.has(id) && !anonymousLinks.has(id) && !endedPlaceholders.has(named)) {
					endedPlaceholders.add(named);
					nodeOps.push({ "op": "spawn", "spec": { "id": named, "dynamic": true } }, { "op": "terminate", "id": named });
				}

				return named;
			}

			return id;
		};

		for (const map of [counts, totals]) {
			for (const [key, entry] of [...map]) {
				if (entry.from.startsWith(PENDING_LINK) || entry.to.startsWith(PENDING_LINK)) {
					map.delete(key);
					add(map, { ...entry, "from": resolve(entry.from), "to": resolve(entry.to) });
				}
			}
		}

		for (const sample of samples) {
			sample.from = resolve(sample.from);
			sample.to = resolve(sample.to);
		}
	}

	function nodeOp(op: NodeOp): void {
		nodeOps.push(op);
		schedule();
	}

	function peerOf(link: LinkInfo): string {
		return link.peerId ?? PENDING_LINK + link.id;
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

					record(self, peerOf(event.link), kind, label, approxSize(frame.data), "hub");
				} else {
					record(self, peerOf(event.link), "lifecycle", frame.hub === "hello" ? "hello" : "interest (" + frame.hub + ")", 0, "hub");
				}

				break;
			}

			case "receive": {
				// Replies are labelled from the call we saw going out; learn calls arriving too.
				const { frame } = event;

				// A hello without an id: an older hub that will never say who it is.
				if ("hub" in frame && frame.hub === "hello" && frame.id === undefined) {
					anonymousLinks.add(PENDING_LINK + event.link.id);
					schedule();
				} else if ("hub" in frame && frame.hub === "hello" && frame.id !== undefined) {
					knownPeers.set(PENDING_LINK + event.link.id, frame.id);
				}

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
	const disposeSync = hub.subscribe(SYNC_SUBJECT, () => {
		setTimeout(() => {
			// Deltas still pending are part of the totals below: send them FIRST so they reach a viewer before the
			// full state (which then replaces this reporter's counts) — never after it, where they'd count twice.
			if (timer !== undefined) {
				clearTimeout(timer);
			}

			flush();
			resolvePendingLinks();
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
				// Still-pending traffic isn't in the totals yet: it arrives as a delta once its link is named.
				"traffic": [...totals.values()].filter((entry) => !isPending(entry))
			});
		}, 0);
	});

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
		"record": (from, to, kind, label, bytes, count) => { record(from, to, kind, label, bytes, undefined, count); },
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
