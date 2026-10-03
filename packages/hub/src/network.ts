/**
 * A virtual network for testing hubs: in-memory links on a simulated clock with seeded fault injection, so a whole
 * tree — a referee and N clients, say — runs in one process, deterministically and instantly.
 *
 * Every frame waits `latencyMs` (± `jitterMs`, which reorders) and nothing is delivered until the clock is advanced.
 * Faults (drop, duplicate, jitter) apply only to the messages `faulty` selects — by default every message but the
 * system's (`$rpc.…`, `$sys.…`). Control frames are never faulted: they stay reliable, as on a reliable signaling
 * channel beside an unreliable data channel.
 */
import type { Hub, LinkOptions, Transport } from "./index.ts";
import { frameOf, pipe } from "./index.ts";

export interface Faults {
	/** Probability (0–1) that a faultable message is dropped. */
	"drop"?: number;
	/** Probability (0–1) that a faultable message is delivered twice. */
	"duplicate"?: number;
	/** Base one-way latency. Default 10ms. */
	"latencyMs"?: number;
	/** Extra random latency, 0 to `jitterMs`, per faultable message — enough of it reorders them. */
	"jitterMs"?: number;
}

export interface NetworkStats {
	"sent": number;
	"delivered": number;
	"dropped": number;
	"duplicated": number;
}

export interface NetworkOptions {
	/** Seeds the default `random`, so a run's losses and reorderings repeat exactly. Default 1. */
	"seed"?: number;
	/** The faults' randomness: an unsigned 32-bit integer per call. Default: a generator seeded with `seed` — pass your
	 *  own to keep a run identical to one made with it. */
	"random"?: () => number;
	/** Which messages faults apply to, by subject. Default: all but the system's (`$…`). */
	"faulty"?: (subject: string) => boolean;
}

export interface Network {
	/** Link two hubs over a fresh pair of in-memory transports, with each end's hub link options (e.g. the id and
	 *  permissions `left` assigns `right`) and, in `through`, what each end's transport passes through first (e.g. the
	 *  edge naming what arrives: observability's scopedTransport). Returns an unlink for both ends. */
	"link": (left: Hub, right: Hub, faults?: Faults, options?: { "left"?: LinkOptions; "right"?: LinkOptions; "through"?: { "left"?: (transport: Transport) => Transport; "right"?: (transport: Transport) => Transport } }) => () => void;
	/** Advance the clock by `ms`, delivering every frame due by then (in time order; frames sent during delivery that
	 *  fall due within the window are delivered too). */
	"advance": (ms: number) => void;
	/** Advance until nothing is in flight (bounded, in case two hubs keep each other busy). */
	"settle": (maxMs?: number) => void;
	"now": () => number;
	"stats": NetworkStats;
}

/** mulberry32: a small, fast, seeded generator of unsigned 32-bit integers. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6D2B79F5) >>> 0;

		let mixed = state;

		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

		return (mixed ^ (mixed >>> 14)) >>> 0;
	};
}

export function createNetwork({ seed = 1, random = seeded(seed), faulty = (subject) => !subject.startsWith("$") }: NetworkOptions = {}): Network {
	const chance = (probability: number): boolean => probability > 0 && random() / 0x100000000 < probability;
	const queue: { "at": number; "order": number; "deliver": () => void }[] = [];
	const stats: NetworkStats = { "sent": 0, "delivered": 0, "dropped": 0, "duplicated": 0 };
	let now = 0;
	let order = 0;

	function enqueue(at: number, deliver: () => void): void {
		order += 1;
		queue.push({ "at": at, "order": order, "deliver": deliver });
	}

	/** How each frame on a link travels (pipe's `schedule` asks): on the simulated clock, with this link's faults applied
	 *  to faultable messages. */
	function travel(faults: Faults) {
		const latency = faults.latencyMs ?? 10;

		return (deliver: () => void, message: unknown): void => {
			stats.sent += 1;

			const frame = frameOf(message);
			const lossy = frame !== undefined && !("hub" in frame) && faulty(frame.subject);
			const counted = (): void => {
				stats.delivered += 1;
				deliver();
			};

			if (lossy && chance(faults.drop ?? 0)) {
				stats.dropped += 1;

				return;
			}

			const jitter = lossy && (faults.jitterMs ?? 0) > 0 ? random() % ((faults.jitterMs ?? 0) + 1) : 0;

			enqueue(now + latency + jitter, counted);

			if (lossy && chance(faults.duplicate ?? 0)) {
				stats.duplicated += 1;
				enqueue(now + latency + jitter + 1, counted);
			}
		};
	}

	function advance(ms: number): void {
		const target = now + ms;

		for (;;) {
			let next = -1;

			for (let index = 0; index < queue.length; index += 1) {
				const entry = queue[index];

				if (entry.at <= target && (next === -1 || entry.at < queue[next].at || (entry.at === queue[next].at && entry.order < queue[next].order))) {
					next = index;
				}
			}

			if (next === -1) {
				break;
			}

			const [entry] = queue.splice(next, 1);

			now = entry.at;
			entry.deliver();
		}

		now = target;
	}

	return {
		"link": (left, right, faults = {}, options = {}) => {
			const [leftEnd, rightEnd] = pipe({ "schedule": travel(faults) });
			const unlinkLeft = left.link(options.through?.left?.(leftEnd) ?? leftEnd, options.left);
			const unlinkRight = right.link(options.through?.right?.(rightEnd) ?? rightEnd, options.right);

			return () => {
				unlinkLeft();
				unlinkRight();
			};
		},
		"advance": advance,
		"settle": (maxMs = 10_000) => {
			const until = now + maxMs;

			while (queue.length > 0 && now < until) {
				advance(Math.max(1, Math.min(...queue.map((entry) => entry.at)) - now));
			}
		},
		"now": () => now,
		"stats": stats
	};
}
