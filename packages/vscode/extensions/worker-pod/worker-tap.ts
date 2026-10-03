/**
 * The tap in every worker a preview starts (the dev server puts it first in a worker's entry script — node-worker.ts):
 * the same console / error capture and WebSocket gate as a page's (tap-shared.ts). A worker reaches the editor through
 * its parent: the page that started it hands it a port onto the window's hub as its first message (`WORKER_OFFER`,
 * page-tap.ts), and this takes that message before the app's own handlers see it, joins the hub, and from then on
 * sends its records (`tap.worker.log`) and asks its capability questions (`tap.worker.decide`) through the page's tap.
 * A worker this worker starts gets a port onto this worker's hub the same way. A shared worker gets the offer on the
 * port of the first page that connects.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Decide, TapRecord } from "./tap-shared";
import { createHub, createRpcClient, portTransport } from "@brianjenkins94/hub";
import { VIRTUAL_RE } from "../../virtual-path";
import { installConsoleTap, installSocketGate, WORKER_OFFER } from "./tap-shared";

/** Records kept until the page's port arrives (beyond this, the oldest go). */
const KEEP_UNTIL_JOINED = 200;
/** How long a capability question waits for the page's port before it's denied. */
const JOIN_WAIT_MS = 10_000;

function install(): void {
	const self = globalThis as typeof globalThis & { "__obsTap"?: true };

	if (self.__obsTap === true) {
		return;
	}

	self.__obsTap = true;

	const worker = VIRTUAL_RE.exec(location.pathname)?.[3] || location.pathname;
	// This worker's hub (its records name its script; the id only tells one worker from another — it can't hold the
	// script's path: a hub id is one token of a subject, and one segment of the app's node ids under its window).
	const hub = createHub({ "id": "worker-tap-" + crypto.randomUUID().slice(0, 4) });
	const rpc = createRpcClient(hub);
	const waiting: TapRecord[] = [];
	let joined = false;
	// Records flow once the page has said it takes them (its interest reaches us a moment after the link opens: a
	// publish before that goes nowhere).
	let flowing = false;
	let resolveJoined: () => void = () => undefined;
	const whenJoined = new Promise<void>((resolve) => { resolveJoined = resolve; });

	const publish = (record: TapRecord): void => { hub.publish("tap.worker.log", { "record": { ...record, "attrs": { "worker": worker, ...record.attrs } } }); };
	const join = (port: MessagePort): void => {
		if (joined) {
			return;
		}

		joined = true;
		hub.link(portTransport(port), { "uplink": true });
		resolveJoined();
		void hub.whenInterested("tap.worker.log", JOIN_WAIT_MS).then((interested) => {
			flowing = interested;

			for (const record of interested ? waiting.splice(0) : []) {
				publish(record);
			}
		});
	};
	// The offer, taken before the app's handlers (registered after this one) see it.
	const takeOffer = (event: MessageEvent): void => {
		const data = event.data as Record<string, unknown> | null;
		const port = event.ports[0];

		if (data !== null && typeof data === "object" && data[WORKER_OFFER] === true && port !== undefined) {
			event.stopImmediatePropagation();
			join(port);
		}
	};

	globalThis.addEventListener("message", takeOffer as EventListener);
	// A shared worker: each page connects on a port of its own, and its offer comes on it.
	globalThis.addEventListener("connect", ((event: MessageEvent) => {
		event.ports[0]?.addEventListener("message", takeOffer);
	}) as EventListener);

	const send = (record: TapRecord): void => {
		try {
			if (flowing) {
				publish(record);
			} else {
				waiting.push(record);
				waiting.splice(0, Math.max(0, waiting.length - KEEP_UNTIL_JOINED));
			}
		} catch { /* a tap never breaks the app */ }
	};
	// Unanswered, or no page to ask ⇒ deny.
	const decide: Decide = async (kind, resource) => {
		const ready = await Promise.race([whenJoined.then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, JOIN_WAIT_MS); })]);

		return ready && await rpc.request("tap.worker.decide", { "kind": kind, "resource": resource }, { "timeoutMs": 300_000, "waitForResponderMs": JOIN_WAIT_MS }).then((allow) => allow === true, () => false);
	};

	installConsoleTap(send);
	installSocketGate(decide);
	adoptWorkers(hub);
}

/** A worker this worker starts joins this worker's hub, as this one joined its page's. */
function adoptWorkers(hub: Hub): void {
	const Original = (globalThis as { "Worker"?: typeof Worker }).Worker;

	if (Original === undefined) {
		return;
	}

	(globalThis as { "Worker": unknown }).Worker = class extends Original {
		public constructor(url: string | URL, options?: WorkerOptions) {
			super(url, options);

			const { port1, port2 } = new MessageChannel();

			try {
				super.postMessage({ [WORKER_OFFER]: true }, [port2]);
				hub.link(portTransport(port1));
			} catch { /* a tap never breaks the app */ }
		}
	};
}

install();
