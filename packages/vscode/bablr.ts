/**
 * The editor's BABLR worker, from the workbench realm: started once, linked into the workbench hub, and asked one call at
 * a time. BABLR is a VM interpreter — about 14ms a line — so it never runs on the UI thread, and what it's asked for
 * queues: the cosmetic classifier's verdicts and edit groups (cosmetic-classifier.ts), the runtime evidence's span ids
 * (evidence.ts). The worker itself is bablr-worker.ts; the pod reaches it over the hub directly (`bablr.spans`, for its
 * `editor.bablr.spans` command).
 *
 * One worker for now. If BABLR's cost outgrows it, a pool goes here, behind `request` — its callers don't change.
 *
 * ABORT: the worker yields between parse chunks, so a cancelled call's signal reaches it mid-run and it bails
 * cooperatively (the worker stays warm); a still-queued call is dropped unsent. A worker that fails to load, or dies,
 * fails what's in flight and every later call.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, portTransport } from "@brianjenkins94/hub";

export interface Bablr {
	/** Ask the worker for `bablr.<name>` (bablr-worker.ts), after whatever was asked before. No timeout: the first call
	 *  waits out the worker's (large) bundle loading, and a parse takes what it takes; `signal` and a dead worker end it. */
	"request": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T>;
	"dispose": () => void;
}

export function startBablr(hub: Hub): Bablr {
	const worker = new Worker(new URL("./lsp/bablr-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	const rpc = createRpcClient(hub);
	const dead = new AbortController();

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		dead.abort(new Error("BABLR worker failed: " + (event.message || "could not load")));
	});

	// One call at a time: BABLR is slow, and the newest request is the one someone is waiting on.
	let tail: Promise<unknown> = Promise.resolve();

	return {
		"request": <T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> => {
			const combined = signal === undefined ? dead.signal : AbortSignal.any([signal, dead.signal]);
			// An already-aborted signal skips the call unsent.
			const run = tail.then(() => rpc.request("bablr." + name, args, { "timeoutMs": Infinity, "waitForResponderMs": 30000, "signal": combined }) as Promise<T>);

			tail = run.catch(() => undefined);

			// Reject a queued call as soon as it's aborted, not when its turn comes.
			return new Promise<T>((resolve, reject) => {
				const onAbort = (): void => { reject(combined.reason); };

				combined.addEventListener("abort", onAbort, { "once": true });
				run.then(resolve, reject).finally(() => { combined.removeEventListener("abort", onAbort); });
			});
		},
		"dispose": () => {
			unlink();
			worker.terminate();
		}
	};
}
