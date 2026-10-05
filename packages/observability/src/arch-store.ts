/**
 * The viewer side of the architecture plane: folds every reporter's `ArchReport`s into one picture — nodes, the
 * channels between them (hub links and probed channels), per-message counts, rates, and a log of sampled traffic.
 * Plain data plus listeners; no DOM, so a Node collector (debug-mcp) can hold one too.
 *
 * Counts are kept PER REPORTER: a reporter's full-state answer to a sync REPLACES its contribution (its totals
 * already include every delta it sent before), so a viewer opened late never counts anything twice.
 *
 * A MEDIUM only two contexts use — a BroadcastChannel or a WebRTC data channel between a client and its referee — is
 * drawn as one edge between them, marked with it (`medium`), rather than as a node of its own: what the probes see
 * physically (client → channel → referee), read as what it is. `channels` is that picture; the channels as reported
 * stay underneath it.
 */
import type { ArchNodeSpec, ArchReport, NodeState, TrafficCount, TrafficKind } from "./arch.ts";
import { SILENCE_MS } from "./arch.ts";

export interface RuntimeNode {
	"id": string;
	"spec": ArchNodeSpec;
	"state": NodeState;
	/** Live instances (a worker may be re-created; two hubs may report the same peer). */
	"instances": number;
	"spawnCount": number;
	"createdAt"?: number;
	"endedAt"?: number;
	/** When it last ended — kept when it comes back (a page reloaded under the same id), so whatever ran under it before
	 *  (its workers, which can't say they went) can be told from what runs under it now (appEnded). */
	"lastEndedAt"?: number;
	/** Which reporters mention it. */
	"reporters": Set<string>;
}

export interface LabelStats {
	"count": number;
	"bytes": number;
	"forward": number;
	"backward": number;
	/** How many rode the hub (the label is then a subject) — the rest were observed by probes. */
	"hub": number;
}

export interface ChannelStats {
	"id": string;
	/** Endpoints; "forward" means a → b. */
	"a": string;
	"b": string;
	"count": number;
	"bytes": number;
	"forward": number;
	"backward": number;
	"errors": number;
	/** A hub link joins the two (both ends' hubs saw each other), whether or not traffic flowed. */
	"linked": boolean;
	/** The medium between the two, when they meet through one only they use (a BroadcastChannel's node id). */
	"medium"?: string;
	/** Per hub end: the subjects the far side has asked it for (the link's remote interest). */
	"interest": Record<string, string[]>;
	"firstAt": number;
	"lastAt": number;
	"labels": Map<string, LabelStats>;
	"recent": StoredSample[];
	/** [time, count] of recent deltas — for the rate. */
	"window": [number, number][];
}

/** A sampled message, as kept per channel (`payload`: its captured preview, when payload capture was on). */
export interface StoredSample { "seq": number; "t": number; "channel": string; "forward": boolean; "kind": TrafficKind; "label": string; "bytes": number; "reporter": string; "payload"?: string; "id"?: string; "cause"?: string }

const RECENT_PER_CHANNEL = 200;
/** The roles of nodes that carry messages between contexts rather than being one: drawn as an edge when two use them —
 *  a BroadcastChannel, a WebRTC data channel, a peer connection (the probes' roles: arch-probes.ts). */
const MEDIUM_ROLES = new Set(["channel", "data channel", "peer connection"]);
const LOG_SIZE = 3000;
const RATE_WINDOW_MS = 2000;

type Listener = () => void;
type SampleListener = (sample: StoredSample, channel: ChannelStats) => void;

interface Picture {
	"channels": Map<string, ChannelStats>;
	/** Each medium drawn as an edge, with the two contexts on it. */
	"media": Map<string, [string, string]>;
	/** A reported channel folded into a medium's edge → that edge's id. */
	"folded": Map<string, string>;
}

export class ArchitectureStore {
	public readonly nodes = new Map<string, RuntimeNode>();
	public readonly log: StoredSample[] = [];
	public readonly topology = new Map<string, NonNullable<ArchReport["topology"]>>();
	/** Where each reporting hub runs (ArchRealm), by reporter. */
	public readonly realms = new Map<string, NonNullable<ArchReport["realm"]>>();
	/** Reporters seen, with when they last reported. */
	public readonly reporters = new Map<string, number>();

	/** The channels as reported, between whatever ends the probes named. */
	private readonly reported = new Map<string, ChannelStats>();
	private picture: Picture | undefined;
	private readonly contributions = new Map<string, Map<string, TrafficCount>>();
	private readonly topologyListeners = new Set<Listener>();
	private readonly sampleListeners = new Set<SampleListener>();
	private scheduled = false;
	private seq = 0;

	public onTopologyChange(listener: Listener): () => void {
		this.topologyListeners.add(listener);

		return () => { this.topologyListeners.delete(listener); };
	}

	public onSample(listener: SampleListener): () => void {
		this.sampleListeners.add(listener);

		return () => { this.sampleListeners.delete(listener); };
	}

	private changed(): void {
		if (this.scheduled) {
			return;
		}

		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;

			for (const listener of this.topologyListeners) {
				listener();
			}
		});
	}

	public node(id: string, spec: ArchNodeSpec = { "id": id }): RuntimeNode {
		let node = this.nodes.get(id);

		if (node === undefined) {
			node = { "id": id, "spec": { ...spec, "id": id }, "state": "declared", "instances": 0, "spawnCount": 0, "reporters": new Set() };
			this.nodes.set(id, node);
			this.changed();
		} else if (Object.keys(spec).length > 1) {
			node.spec = { ...node.spec, ...spec, "meta": { ...node.spec.meta, ...spec.meta } };
		}

		return node;
	}

	private spawn(spec: ArchNodeSpec, reporter: string): void {
		const node = this.node(spec.id, spec);

		node.instances += 1;
		node.spawnCount += 1;
		node.state = "alive";
		node.createdAt ??= Date.now();
		node.endedAt = undefined;
		node.reporters.add(reporter);
		this.changed();
	}

	private terminate(id: string): void {
		const node = this.nodes.get(id);

		if (node === undefined || node.instances === 0) {
			return;
		}

		node.instances -= 1;

		if (node.instances === 0) {
			node.state = "terminated";
			node.endedAt = Date.now();
		}

		this.changed();
	}

	/** A node carrying traffic exists even if nobody spawned it (a network endpoint, storage, a hub peer). */
	private markUsed(id: string, reporter?: string): void {
		const node = this.node(id);

		if (reporter !== undefined) {
			node.reporters.add(reporter);
		}

		if (node.state === "declared") {
			node.state = "alive";
			node.createdAt ??= Date.now();
			this.changed();
		}
	}

	/** The channels to draw: every reported one, except that a medium two contexts share is one edge between them. */
	public get channels(): Map<string, ChannelStats> {
		return this.draw().channels;
	}

	/** Each medium drawn as an edge, with the two contexts on it. */
	public media(): Map<string, [string, string]> {
		return this.draw().media;
	}

	/** A channel by id: one drawn, or one as reported (a sample's `channel`, folded into a medium's edge or not). */
	public channelById(id: string): ChannelStats | undefined {
		return this.draw().channels.get(id) ?? this.reported.get(id);
	}

	/** The channel drawn between two contexts, if any. */
	public between(a: string, b: string): ChannelStats | undefined {
		return [...this.channels.values()].find((channel) => (channel.a === a && channel.b === b) || (channel.a === b && channel.b === a));
	}

	/** The channel as reported between `a` and `b` (created if new); `reversed` when it runs b → a. */
	public channel(a: string, b: string): { "channel": ChannelStats; "reversed": boolean } {
		const direct = this.reported.get(a + "|" + b);

		if (direct !== undefined) {
			return { "channel": direct, "reversed": false };
		}

		const reverse = this.reported.get(b + "|" + a);

		if (reverse !== undefined) {
			return { "channel": reverse, "reversed": true };
		}

		const now = Date.now();
		const created: ChannelStats = {
			"id": a + "|" + b,
			"a": a,
			"b": b,
			"count": 0,
			"bytes": 0,
			"forward": 0,
			"backward": 0,
			"errors": 0,
			"linked": false,
			"interest": {},
			"firstAt": now,
			"lastAt": now,
			"labels": new Map(),
			"recent": [],
			"window": []
		};

		this.reported.set(created.id, created);
		this.picture = undefined;
		this.changed();

		return { "channel": created, "reversed": false };
	}

	/** Add (or, with a negative count, remove) traffic to a channel's stats. */
	private addTraffic(entry: TrafficCount, count: number, bytes: number, inWindow: boolean): void {
		const { channel, reversed } = this.channel(entry.from, entry.to);
		const forward = !reversed;
		const now = Date.now();

		channel.count += count;
		channel.bytes += bytes;
		channel[forward ? "forward" : "backward"] += count;

		if (entry.kind === "error") {
			channel.errors += count;
		}

		let label = channel.labels.get(entry.label);

		if (label === undefined) {
			label = { "count": 0, "bytes": 0, "forward": 0, "backward": 0, "hub": 0 };
			channel.labels.set(entry.label, label);
		}

		label.count += count;
		label.bytes += bytes;

		if (entry.via === "hub") {
			label.hub += count;
		}

		label[forward ? "forward" : "backward"] += count;

		if (count > 0) {
			channel.lastAt = now;
		}

		if (inWindow && count > 0) {
			channel.window.push([now, count]);

			while (channel.window.length > 0 && now - channel.window[0][0] > RATE_WINDOW_MS) {
				channel.window.shift();
			}
		}
	}

	/** Messages per second over the last couple of seconds. */
	public rate(channel: ChannelStats, now = Date.now()): number {
		let total = 0;

		for (const [time, count] of channel.window) {
			if (now - time <= RATE_WINDOW_MS) {
				total += count;
			}
		}

		return (total * 1000) / RATE_WINDOW_MS;
	}

	/** Fold one report in. */
	public apply(report: ArchReport): void {
		const { reporter } = report;

		this.reporters.set(reporter, Date.now());
		this.markUsed(reporter, reporter);

		// Its page went (arch.ts, on pagehide): ended — fading like any context that ended. Any other report from it is
		// it back (a reloaded page).
		const self = this.nodes.get(reporter)!;

		if (report.ended === true) {
			self.state = "terminated";
			self.endedAt = Date.now();
			self.lastEndedAt = self.endedAt;
			this.changed();

			return;
		}

		if (self.state === "terminated" && self.lastEndedAt !== undefined) {
			self.state = "alive";
			self.endedAt = undefined;
			this.changed();
		}

		for (const op of report.nodes ?? []) {
			switch (op.op) {
				case "declare":
					this.node(op.spec.id, op.spec).reporters.add(reporter);
					break;
				case "spawn":
					this.spawn(op.spec, reporter);
					break;
				case "terminate":
					this.terminate(op.id);
					break;
				case "state": {
					const node = this.nodes.get(op.id);

					if (node !== undefined && node.state !== "terminated" && node.state !== op.state) {
						node.state = op.state;
						this.changed();
					}

					break;
				}

				default:
					break;
			}
		}

		let contribution = this.contributions.get(reporter);

		if (contribution === undefined) {
			contribution = new Map();
			this.contributions.set(reporter, contribution);
		}

		if (report.full === true) {
			// Totals replace this reporter's contribution: apply only the difference.
			const next = new Map((report.traffic ?? []).map((entry) => [trafficKey(entry), entry]));

			for (const [key, previous] of contribution) {
				if (!next.has(key)) {
					this.addTraffic(previous, -previous.count, -previous.bytes, false);
				}
			}

			for (const [key, entry] of next) {
				const previous = contribution.get(key);

				this.markUsed(entry.from);
				this.markUsed(entry.to);
				this.addTraffic(entry, entry.count - (previous?.count ?? 0), entry.bytes - (previous?.bytes ?? 0), false);
			}

			this.contributions.set(reporter, new Map([...next].map(([key, entry]) => [key, { ...entry }])));
		} else {
			for (const entry of report.traffic ?? []) {
				const key = trafficKey(entry);
				const previous = contribution.get(key);

				this.markUsed(entry.from);
				this.markUsed(entry.to);
				this.addTraffic(entry, entry.count, entry.bytes, true);

				if (previous === undefined) {
					contribution.set(key, { ...entry });
				} else {
					previous.count += entry.count;
					previous.bytes += entry.bytes;
				}
			}
		}

		// After the traffic: a link this snapshot no longer lists may have carried some of it (see forget).
		if (report.realm !== undefined) {
			this.realms.set(reporter, report.realm);
		}

		if (report.topology !== undefined) {
			this.applyTopology(reporter, report.topology);
		}

		this.picture = undefined;

		// Samples: the log and the animation — replayed at their original pace relative to the report.
		const offset = Date.now() - report.time;

		for (const sample of report.samples ?? []) {
			const { channel, reversed } = this.channel(sample.from, sample.to);

			this.seq += 1;

			const stored: StoredSample = {
				"seq": this.seq,
				"t": sample.t + offset,
				"channel": channel.id,
				"forward": !reversed,
				"kind": sample.kind,
				"label": sample.label,
				"bytes": sample.bytes,
				"reporter": reporter,
				...sample.payload === undefined ? {} : { "payload": sample.payload },
				...sample.id === undefined ? {} : { "id": sample.id },
				...sample.cause === undefined ? {} : { "cause": sample.cause }
			};

			channel.recent.push(stored);

			if (channel.recent.length > RECENT_PER_CHANNEL) {
				channel.recent.shift();
			}

			this.log.push(stored);

			const drawn = this.drawnSample(stored, channel);

			if (drawn !== undefined) {
				for (const listener of this.sampleListeners) {
					listener(drawn.sample, drawn.channel);
				}
			}
		}

		this.picture = undefined;

		if (this.log.length > LOG_SIZE) {
			this.log.splice(0, this.log.length - LOG_SIZE);
		}
	}

	private applyTopology(reporter: string, snapshot: NonNullable<ArchReport["topology"]>): void {
		this.topology.set(reporter, snapshot);

		// (A link whose peer hasn't said hello yet has no channel: who's across it is unknown until it does. It's in
		// the topology all the same.)
		for (const link of snapshot.links) {
			const peer = link.peerId;

			if (peer === undefined) {
				continue;
			}

			const { channel } = this.channel(reporter, peer);

			this.markUsed(peer);

			if (!channel.linked) {
				channel.linked = true;
				this.changed();
			}

			channel.interest[reporter] = link.remoteInterest;
		}
	}

	/** A sample as the picture shows it: on its medium's edge, the way it went — or not at all, for the receiving end's
	 *  sighting of a message the sending end already showed. */
	private drawnSample(sample: StoredSample, channel: ChannelStats): { "sample": StoredSample; "channel": ChannelStats } | undefined {
		const picture = this.draw();
		const edgeId = picture.folded.get(channel.id);

		if (edgeId === undefined) {
			return { "sample": sample, "channel": channel };
		}

		const edge = picture.channels.get(edgeId)!;
		const from = sample.forward ? channel.a : channel.b;

		if (from === edge.medium) {
			return undefined;
		}

		return { "sample": { ...sample, "channel": edge.id, "forward": from === edge.a }, "channel": edge };
	}

	private isMedium(id: string): boolean {
		return MEDIUM_ROLES.has(this.nodes.get(id)?.spec.role ?? "");
	}

	/** The picture: the reported channels, with each medium only two contexts use folded into one edge between them. */
	private draw(): Picture {
		if (this.picture !== undefined) {
			return this.picture;
		}

		// Each medium's contexts, and the reported channel to each.
		const onMedium = new Map<string, Map<string, ChannelStats>>();

		for (const channel of this.reported.values()) {
			for (const [end, other] of [[channel.a, channel.b], [channel.b, channel.a]] as const) {
				if (this.isMedium(end) && !this.isMedium(other)) {
					onMedium.set(end, (onMedium.get(end) ?? new Map<string, ChannelStats>()).set(other, channel));
				}
			}
		}

		const picture: Picture = { "channels": new Map(), "media": new Map(), "folded": new Map() };
		const edges: ChannelStats[] = [];

		for (const [medium, ends] of onMedium) {
			if (ends.size === 2) {
				const [[a, toA], [b, toB]] = [...ends] as [[string, ChannelStats], [string, ChannelStats]];
				const edge = mediumEdge(medium, a, toA, b, toB);

				picture.media.set(medium, [a, b]);
				picture.folded.set(toA.id, edge.id);
				picture.folded.set(toB.id, edge.id);
				edges.push(edge);
			}
		}

		for (const channel of this.reported.values()) {
			if (!picture.folded.has(channel.id)) {
				picture.channels.set(channel.id, channel);
			}
		}

		for (const edge of edges) {
			picture.channels.set(edge.id, edge);
		}

		this.picture = picture;

		return picture;
	}

	/** Forget the counts (not the topology). */
	public resetCounters(): void {
		this.picture = undefined;

		for (const channel of this.reported.values()) {
			Object.assign(channel, { "count": 0, "bytes": 0, "forward": 0, "backward": 0, "errors": 0 });
			channel.labels.clear();
			channel.recent.length = 0;
			channel.window.length = 0;
		}

		this.contributions.clear();
		this.log.length = 0;
		this.changed();
	}

	/** End every reporter silent for over SILENCE_MS (a reporter heartbeats while anyone listens, so one that stops has
	 *  gone — a worker whose page went, a realm that crashed). Call before reading; a report brings it back. */
	public sweep(now = Date.now()): void {
		for (const [reporter, heard] of this.reporters) {
			const node = this.nodes.get(reporter);

			if (node !== undefined && node.state !== "terminated" && now - heard > SILENCE_MS) {
				node.state = "terminated";
				node.endedAt = now;
				node.lastEndedAt = now;
				this.changed();
			}
		}
	}

	/** Everything, as JSON-safe data (export, debug-mcp) — silent reporters swept first. */
	public snapshot(): unknown {
		this.sweep();

		return {
			"takenAt": new Date().toISOString(),
			"reporters": Object.fromEntries(this.reporters),
			"topology": Object.fromEntries(this.topology),
			"realms": Object.fromEntries(this.realms),
			"nodes": [...this.nodes.values()].filter((node) => !this.media().has(node.id)).map((node) => ({ ...node, "reporters": [...node.reporters] })),
			"media": [...this.media()].map(([id, between]) => ({ "id": id, "between": between })),
			"channels": [...this.channels.values()].map(({ labels, "window": _window, ...channel }) => ({ ...channel, "labels": Object.fromEntries(labels) })),
			// The recent messages, each with its ends (for flows: flows.ts).
			"log": this.log.map((sample) => {
				const channel = this.reported.get(sample.channel) ?? this.channels.get(sample.channel);

				return { ...sample, "from": sample.forward ? channel?.a : channel?.b, "to": sample.forward ? channel?.b : channel?.a };
			})
		};
	}
}

/**
 * The edge `a ⇄ b` through `medium`, from the channels each has to it as reported (`toA`: a ⇄ medium). Each message is
 * seen at both ends — sent by one, received by the other — so it's counted from the senders' side alone: a → b is what
 * a sent into the medium. (Bytes and errors aren't kept by direction: split in proportion, and halved.)
 */
function mediumEdge(medium: string, a: string, toA: ChannelStats, b: string, toB: ChannelStats): ChannelStats {
	const sentBy = (end: string, channel: ChannelStats): number => (channel.a === end ? channel.forward : channel.backward);
	const forward = sentBy(a, toA);
	const backward = sentBy(b, toB);
	const share = (channel: ChannelStats, sent: number): number => (channel.count === 0 ? 0 : sent / channel.count);
	const labels = new Map<string, LabelStats>();

	for (const [end, channel, way] of [[a, toA, "forward"], [b, toB, "backward"]] as const) {
		for (const [label, stats] of channel.labels) {
			const sent = channel.a === end ? stats.forward : stats.backward;

			if (sent === 0) {
				continue;
			}

			const entry = labels.get(label) ?? { "count": 0, "bytes": 0, "forward": 0, "backward": 0, "hub": 0 };

			entry.count += sent;
			entry[way] += sent;
			entry.bytes += stats.bytes * share({ ...channel, "count": stats.count }, sent);
			entry.hub += stats.hub * share({ ...channel, "count": stats.count }, sent);
			labels.set(label, entry);
		}
	}

	// The senders' sightings, each pointed the way it went on the edge.
	const recent = [...toA.recent, ...toB.recent]
		.map((sample) => {
			const channel = sample.channel === toA.id ? toA : toB;
			const from = sample.forward ? channel.a : channel.b;

			return from === medium ? undefined : { ...sample, "channel": a + "|" + b + "~" + medium, "forward": from === a };
		})
		.filter((sample) => sample !== undefined)
		.sort((left, right) => left.seq - right.seq)
		.slice(-RECENT_PER_CHANNEL);

	return {
		"id": a + "|" + b + "~" + medium,
		"a": a,
		"b": b,
		"medium": medium,
		"count": forward + backward,
		"bytes": toA.bytes * share(toA, forward) + toB.bytes * share(toB, backward),
		"forward": forward,
		"backward": backward,
		"errors": Math.round((toA.errors + toB.errors) / 2),
		"linked": false,
		"interest": {},
		"firstAt": Math.min(toA.firstAt, toB.firstAt),
		"lastAt": Math.max(toA.lastAt, toB.lastAt),
		"labels": labels,
		"recent": recent,
		"window": [...toA.window, ...toB.window].map(([time, count]): [number, number] => [time, count / 2]).sort(([left], [right]) => left - right)
	};
}

function trafficKey(entry: TrafficCount): string {
	return entry.from + "\0" + entry.to + "\0" + entry.kind + "\0" + entry.label + "\0" + (entry.via ?? "");
}
