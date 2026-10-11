/// <reference lib="webworker" />
/**
 * Core's port into a worker it boots (workerBootstrap.worker.ts): posted as the worker's first message — the parent
 * recognizes it that way (probes.ts) — and shared by what core runs there: the architecture probe's reports
 * (probe.worker.ts) and the workspace runtime's links (runtime.worker.ts). One port, because the parent takes a
 * worker's first port as core's and any other as the worker's own (the extension host's is VS Code's RPC).
 */
import type { ProbeMessage } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const channel = new MessageChannel();

self.postMessage(channel.port2, [channel.port2]);

/** Send `messages` to core. */
export function toCore(messages: ProbeMessage[], transfer: Transferable[] = []): void {
	channel.port1.postMessage(messages, transfer);
}
