/// <reference lib="webworker" />
/**
 * Probe running INSIDE a worker (the monaco editor workers, the web worker extension host): reports what the
 * workbench can't see from outside — the worker's own requests and the workers IT spawns (the extension host's
 * language servers), including the MessagePorts it talks to them over (tsserver: its protocol, the @vscode/sync-api
 * file system bridge, the file watcher) — over core's port into the worker (workerPort.ts).
 */
import type { ProbeMessage, ProbePeer, TrafficKind } from "./protocol";
import { approxSize, describeMessage } from "./protocol";
import { toCore } from "./workerPort";

declare const self: DedicatedWorkerGlobalScope;

let queue: ProbeMessage[] = [];
// Traffic is aggregated per batch: a language server's ports carry thousands of messages a second.
let tallies = new Map<string, Extract<ProbeMessage, { "type": "traffic" }>>();
let scheduled = false;

function schedule(): void {
	if (!scheduled) {
		scheduled = true;
		setTimeout(() => {
			scheduled = false;

			const batch = [...queue, ...tallies.values()];

			queue = [];
			tallies = new Map();
			toCore(batch);
		}, 100);
	}
}

function report(message: ProbeMessage): void {
	queue.push(message);
	schedule();
}

function traffic(peer: ProbePeer, outgoing: boolean, kind: TrafficKind, label: string, bytes: number): void {
	const key = JSON.stringify([peer, outgoing, kind, label]);
	const tally = tallies.get(key);

	if (tally === undefined) {
		tallies.set(key, { "type": "traffic", "peer": peer, "outgoing": outgoing, "kind": kind, "label": label, "bytes": bytes, "count": 1 });
	} else {
		tally.bytes += bytes;
		tally.count = (tally.count ?? 1) + 1;
	}

	schedule();
}

report({ "type": "hello", "name": self.name, "url": self.location.href });

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

// Which MessageChannel ends pair up, so the end this worker KEEPS can be attributed to the worker the other end is
// sent to. (Core's own channel, workerPort.ts, predates this.)
const partners = new WeakMap<MessagePort, MessagePort>();
const observedPorts = new WeakSet<MessagePort>();

if (typeof globalThis.MessageChannel === "function") {
	const NativeMessageChannel = globalThis.MessageChannel;

	globalThis.MessageChannel = class extends NativeMessageChannel {
		public constructor() {
			super();
			partners.set(this.port1, this.port2);
			partners.set(this.port2, this.port1);
		}
	};
}

/** Count what goes over `port` (this worker's end of a channel whose other end went to `peer`). */
function observePort(port: MessagePort, peer: ProbePeer): void {
	if (observedPorts.has(port)) {
		return;
	}

	observedPorts.add(port);

	const postMessage = port.postMessage.bind(port) as (message: unknown, transfer?: unknown) => void;

	port.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void => {
		const { kind, label } = describeMessage(message);

		traffic(peer, true, kind, label, approxSize(message));
		postMessage(message, transfer);
	};
	// A listener of our own doesn't start the port: it hears messages once the owner does.
	port.addEventListener("message", (event) => {
		const { kind, label } = describeMessage(event.data);

		traffic(peer, false, kind, label, approxSize(event.data));
	});
}

/** The kept ends of the channels whose other ends are in `transfer`. */
function keptEnds(transfer: Transferable[] | StructuredSerializeOptions | undefined): MessagePort[] {
	const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);

	return list.flatMap((item) => {
		const partner = item instanceof MessagePort ? partners.get(item) : undefined;

		return partner === undefined ? [] : [partner];
	});
}

let workerIdPool = 0;

/** The extension a worker is an extension's own of: named by the URL it gives (`extension-file://<publisher>.<name>/…`),
 *  else by its code on the stack — undefined for a worker nothing of an extension's starts. */
function ownerExtension(url: string): string | undefined {
	const extension = /extension-file:\/\/[^./\s]+\.([^/\s]+)\//u;

	return extension.exec(url)?.[1] ?? extension.exec(new Error("the worker's owner").stack ?? "")?.[1];
}

// The owners of workers asked for but not started yet, by worker name, oldest first (see the Worker accessor below).
const pendingOwners = new Map<string, string[]>();

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

			const name = workerName(args[0], args[1]);
			const owner = pendingOwners.get(name)?.shift() ?? ownerExtension(String(args[0]));

			report({ "type": "spawn", "id": id, "name": name, "url": String(args[0]), ...owner === undefined ? {} : { "owner": owner } });

			const postMessage = worker.postMessage.bind(worker) as (message: unknown, transfer?: unknown) => void;

			worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void => {
				const { kind, label } = describeMessage(message);

				traffic(peer, true, kind, label, approxSize(message));

				for (const port of keptEnds(transfer)) {
					observePort(port, peer);
				}

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

	// The extension host puts its own `Worker` over this one (its patchWorker): what an extension calls, and which starts
	// the real worker — this one — later, once it has fetched the script, so by then nothing of the extension is on the
	// stack. Its owner is taken here instead, as the extension calls the extension host's, and found again by name.
	let current = globalThis.Worker;
	const probed = current;

	Object.defineProperty(globalThis, "Worker", {
		"configurable": true,
		"get": () => current,
		"set": (value: typeof Worker) => {
			current = value === probed ? value : new Proxy(value, {
				"construct": function(target, args: [string | URL, WorkerOptions?], newTarget) {
					const owner = ownerExtension(String(args[0]));

					if (owner !== undefined) {
						const name = workerName(args[0], args[1]);

						pendingOwners.set(name, [...pendingOwners.get(name) ?? [], owner]);
					}

					return Reflect.construct(target, args, newTarget) as Worker;
				}
			});
		}
	});
}
