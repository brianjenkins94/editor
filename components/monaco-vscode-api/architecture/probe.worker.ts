/// <reference lib="webworker" />
/**
 * Probe running INSIDE a worker (the monaco editor workers, the web worker extension host): reports what the
 * workbench can't see from outside — the worker's own requests and the workers IT spawns (the extension host's
 * language servers) — through a MessagePort posted as the worker's first message.
 */
import type { ProbeMessage, ProbePeer, TrafficKind } from "./protocol";
import { approxSize, describeMessage } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const channel = new MessageChannel();

// MUST be the worker's first message: the parent recognizes the probe that way.
self.postMessage(channel.port2, [channel.port2]);

let queue: ProbeMessage[] = [];
let scheduled = false;

function report(message: ProbeMessage): void {
	queue.push(message);

	if (!scheduled) {
		scheduled = true;
		setTimeout(() => {
			scheduled = false;

			const batch = queue;

			queue = [];
			channel.port1.postMessage(batch);
		}, 100);
	}
}

function traffic(peer: ProbePeer, outgoing: boolean, kind: TrafficKind, label: string, bytes: number): void {
	report({ "type": "traffic", "peer": peer, "outgoing": outgoing, "kind": kind, "label": label, "bytes": bytes });
}

report({ "type": "hello", "name": self.name });

const nativeFetch = self.fetch;

self.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = input instanceof Request ? input.url : String(input);

	if (url.startsWith("data:") || url.startsWith("blob:")) {
		return nativeFetch.call(this, input, init);
	}

	const peer: ProbePeer = { "type": "http", "url": url };

	traffic(peer, true, "request", init?.method ?? (input instanceof Request ? input.method : "GET"), 0);

	try {
		const response = await nativeFetch.call(this, input, init);

		traffic(peer, false, response.ok ? "reply" : "error", String(response.status), Number(response.headers.get("content-length") ?? 0));

		return response;
	} catch (error) {
		traffic(peer, false, "error", "network error", 0);

		throw error;
	}
};

let workerIdPool = 0;

function workerName(url: string | URL, options?: WorkerOptions): string {
	// The extension host names nested workers `<its name> -> <name or file>`.
	const name = options?.name?.split(" -> ").pop();

	if (name !== undefined && name.length > 0) {
		return name;
	}

	return String(url).split(/[?#]/u)[0].split("/").pop() ?? "worker";
}

if (typeof globalThis.Worker === "function") {
	globalThis.Worker = new Proxy(globalThis.Worker, {
		"construct": function(target, args: [string | URL, WorkerOptions?], newTarget) {
			const worker = Reflect.construct(target, args, newTarget) as Worker;

			workerIdPool += 1;

			const id = String(workerIdPool);
			const peer: ProbePeer = { "type": "worker", "id": id };

			report({ "type": "spawn", "id": id, "name": workerName(args[0], args[1]), "url": String(args[0]) });

			const postMessage = worker.postMessage.bind(worker) as (message: unknown, transfer?: unknown) => void;

			worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void => {
				const { kind, label } = describeMessage(message);

				traffic(peer, true, kind, label, approxSize(message));
				postMessage(message, transfer);
			};

			worker.addEventListener("message", (event) => {
				const { kind, label } = describeMessage(event.data);

				traffic(peer, false, kind, label, approxSize(event.data));
			});
			worker.addEventListener("error", () => { traffic(peer, false, "error", "worker error", 0); });

			const terminate = worker.terminate.bind(worker);

			worker.terminate = () => {
				report({ "type": "end", "id": id });
				terminate();
			};

			return worker;
		}
	});
}
