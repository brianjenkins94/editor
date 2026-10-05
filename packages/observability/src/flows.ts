/**
 * Flows: the messages one message caused, followed across hubs — from the samples reporters send (TrafficSample's `id`
 * and `cause`, which the hub sets: Envelope.id / Envelope.cause). A message is one id, however many hops it took (each
 * hub that forwarded it reports a sample of its own). Where a cause was lost — work a handler did after an `await`,
 * when no handler was running to name — a message is linked to the last message its sender received just before it, and
 * marked `inferred`.
 */

/** A sampled message, as flows read it: when, from whom to whom, what (`label`), and its id and cause. */
export interface FlowSample { "t": number; "from": string; "to": string; "label": string; "kind"?: string; "id"?: string; "cause"?: string }

/** One message of a flow: where it went (every hop), what it caused, and whether its cause is only inferred. */
export interface FlowMessage {
	"id": string;
	"label": string;
	"kind"?: string;
	"t": number;
	/** The hubs it passed through, in order: its sender first. */
	"path": string[];
	"cause"?: string;
	"inferred"?: true;
	"caused": FlowMessage[];
}

/** How soon after a message reaches a hub what it sends next is taken to be on its account, when nothing says. */
export const INFER_WITHIN_MS = 50;

/** The flows in `samples`: each message no other one (sampled) caused, with everything it caused under it. */
export function flowsOf(samples: FlowSample[], inferWithinMs = INFER_WITHIN_MS): FlowMessage[] {
	const messages = new Map<string, FlowMessage>();

	for (const sample of [...samples].sort((a, b) => a.t - b.t)) {
		if (sample.id === undefined) {
			continue;
		}

		const known = messages.get(sample.id);

		if (known === undefined) {
			messages.set(sample.id, { "id": sample.id, "label": sample.label, ...sample.kind === undefined ? {} : { "kind": sample.kind }, "t": sample.t, "path": [sample.from, sample.to], ...sample.cause === undefined ? {} : { "cause": sample.cause }, "caused": [] });
		} else if (known.path.at(-1) === sample.from) {
			known.path.push(sample.to);
		}
	}

	const ordered = [...messages.values()].sort((a, b) => a.t - b.t);

	// A lost cause: the last message to reach this one's sender, shortly before it.
	for (const message of ordered) {
		if (message.cause !== undefined) {
			continue;
		}

		const sender = message.path[0];
		const before = ordered.filter((other) => other !== message && other.path.slice(1).includes(sender!) && other.t <= message.t && message.t - other.t <= inferWithinMs).at(-1);

		if (before !== undefined) {
			message.cause = before.id;
			message.inferred = true;
		}
	}

	const roots: FlowMessage[] = [];

	for (const message of ordered) {
		const parent = message.cause === undefined ? undefined : messages.get(message.cause);

		if (parent === undefined || parent === message) {
			roots.push(message);
		} else {
			parent.caused.push(message);
		}
	}

	return roots;
}
