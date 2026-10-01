/**
 * The viewer side of the architecture plane: folds every reporter's `ArchReport`s into one picture — nodes, the
 * channels between them (hub links and probed channels), per-message counts, rates, and a log of sampled traffic.
 * Plain data plus listeners; no DOM, so a Node collector (debug-mcp) can hold one too.
 *
 * Counts are kept PER REPORTER: a reporter's full-state answer to a sync REPLACES its contribution (its totals
 * already include every delta it sent before), so a viewer opened late never counts anything twice.
 */
import type { ArchNodeSpec, ArchReport, NodeState, TrafficCount, TrafficKind } from "./arch.ts";

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
	/** Per hub end: the subjects the far side has asked it for (the link's remote interest). */
	"interest": Record<string, string[]>;
	"firstAt": number;
	"lastAt": number;
	"labels": Map<string, LabelStats>;
	"recent": StoredSample[];
	/** [time, count] of recent deltas — for the rate. */
	"window": [number, number][];
}

export interface StoredSample { "seq": number; "t": number; "channel": string; "forward": boolean; "kind": TrafficKind; "label": string; "bytes": number; "reporter": string }

const RECENT_PER_CHANNEL = 200;
const LOG_SIZE = 3000;
const RATE_WINDOW_MS = 2000;

type Listener = () => void;
type SampleListener = (sample: StoredSample, channel: ChannelStats) => void;

export class ArchitectureStore {
	public readonly nodes = new Map<string, RuntimeNode>();
	public readonly channels = new Map<string, ChannelStats>();
	public readonly log: StoredSample[] = [];
	public readonly topology = new Map<string, NonNullable<ArchReport["topology"]>>();
	/** Where each reporting hub runs (ArchRealm), by reporter. */
	public readonly realms = new Map<string, NonNullable<ArchReport["realm"]>>();
	/** Reporters seen, with when they last reported. */
	public readonly reporters = new Map<string, number>();

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

	public channel(a: string, b: string): { "channel": ChannelStats; "reversed": boolean } {
		const direct = this.channels.get(a + "|" + b);

		if (direct !== undefined) {
			return { "channel": direct, "reversed": false };
		}

		const reverse = this.channels.get(b + "|" + a);

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

		this.channels.set(created.id, created);
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
				"reporter": reporter
			};

			channel.recent.push(stored);

			if (channel.recent.length > RECENT_PER_CHANNEL) {
				channel.recent.shift();
			}

			this.log.push(stored);

			for (const listener of this.sampleListeners) {
				listener(stored, channel);
			}
		}

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

	/** Forget the counts (not the topology). */
	public resetCounters(): void {
		for (const channel of this.channels.values()) {
			Object.assign(channel, { "count": 0, "bytes": 0, "forward": 0, "backward": 0, "errors": 0 });
			channel.labels.clear();
			channel.recent.length = 0;
			channel.window.length = 0;
		}

		this.contributions.clear();
		this.log.length = 0;
		this.changed();
	}

	/** Everything, as JSON-safe data (export, debug-mcp). */
	public snapshot(): unknown {
		return {
			"takenAt": new Date().toISOString(),
			"reporters": Object.fromEntries(this.reporters),
			"topology": Object.fromEntries(this.topology),
			"realms": Object.fromEntries(this.realms),
			"nodes": [...this.nodes.values()].map((node) => ({ ...node, "reporters": [...node.reporters] })),
			"channels": [...this.channels.values()].map(({ labels, "window": _window, ...channel }) => ({ ...channel, "labels": Object.fromEntries(labels) }))
		};
	}
}

function trafficKey(entry: TrafficCount): string {
	return entry.from + "\0" + entry.to + "\0" + entry.kind + "\0" + entry.label + "\0" + (entry.via ?? "");
}
