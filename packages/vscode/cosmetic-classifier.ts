/**
 * Cosmetic-vs-semantic classification service — the reusable seam between BABLR and any consumer.
 *
 * Owns the classify worker (BABLR is a VM interpreter, too slow for the UI thread); takes two text versions and
 * returns a verdict — no cache (see the note below). Knows NOTHING about git or SCM — the git SCM binding (`git-scm.ts`) is
 * merely one consumer, and a future standalone classifier extension would be another. That decoupling is the point:
 * the novel capability (tell cosmetic from semantic) lives here, independent of whatever provider surfaces it.
 *
 * ABORT: the worker runs a YIELDING classifier (`classifyChangeAsync`), so it pauses between chunks of the parse and
 * its message loop can see an `{ abort }` message mid-run. The classifier drives ONE request at a time (a serial
 * queue); to cancel the running one it posts an abort for that id and the worker bails cooperatively (the worker and
 * its cache stay warm — no termination). Aborting a still-queued request just drops it.
 */

/** BABLR's verdict for a change (mirrors `@brianjenkins94/bablr`'s classifyChange). */
export type ChangeKind = "cosmetic" | "semantic" | "unparsable";

export interface CosmeticClassifier {
	/**
	 * Classify the change from `before` to `after`. Not cached (a content-derived key can be wrong — see the note on
	 * createCosmeticClassifier); only identical text short-circuits. Pass an `AbortSignal` to cancel: if the request
	 * is already running, the worker bails cooperatively at its next yield and the promise rejects with an AbortError.
	 */
	"classify": (before: string, after: string, signal?: AbortSignal) => Promise<ChangeKind>;
	/** Tear down the worker. */
	"dispose": () => void;
}

interface ClassifyResponse { "id": number; "kind"?: ChangeKind; "aborted"?: true }

interface QueueItem {
	"id": number;
	"before": string;
	"after": string;
	"resolve": (kind: ChangeKind) => void;
	"reject": (error: unknown) => void;
	"aborted": boolean;
}

/**
 * Create a classifier backed by the BABLR classify worker (served at `lsp/classify-worker.js`).
 *
 * NOTE: no verdict cache. A content-derived key (hash or size) carries a chance of returning a stale/wrong verdict,
 * and the correct key is a STABLE IDENTITY for the changed code (track a line/node as it moves) — the persisted-CST /
 * patch-identity direction — which we haven't built yet. Until then the only shortcut is the exact `before === after`.
 */
export function createCosmeticClassifier(): CosmeticClassifier {
	const queue: QueueItem[] = [];
	let running: QueueItem | undefined;
	let nextId = 0;

	const worker = new Worker(new URL("./lsp/classify-worker.js", location.href), { "type": "module" });

	worker.addEventListener("message", (event: MessageEvent<ClassifyResponse>) => {
		if (running === undefined || event.data.id !== running.id) {
			return; // stale / already settled
		}

		const settled = running;

		running = undefined;

		if (event.data.aborted === true || event.data.kind === undefined) {
			settled.reject(new DOMException("classification aborted", "AbortError"));
		} else {
			settled.resolve(event.data.kind);
		}

		pump();
	});

	function pump(): void {
		if (running !== undefined) {
			return;
		}

		// Drop any requests that were aborted while queued.
		while (queue.length > 0 && queue[0].aborted) {
			queue.shift();
		}

		const next = queue.shift();

		if (next === undefined) {
			return;
		}

		running = next;
		worker.postMessage({ "id": next.id, "before": next.before, "after": next.after });
	}

	return {
		"classify": async (before, after, signal) => {
			if (before === after) {
				return "cosmetic"; // identical text — the only provably-correct shortcut
			}

			if (signal?.aborted === true) {
				throw new DOMException("classification aborted", "AbortError");
			}

			return new Promise<ChangeKind>((resolve, reject) => {
				const item: QueueItem = { "id": nextId, "before": before, "after": after, "resolve": resolve, "reject": reject, "aborted": false };

				nextId += 1;
				queue.push(item);

				signal?.addEventListener("abort", () => {
					if (item.aborted) {
						return;
					}

					item.aborted = true;

					if (running === item) {
						// Mid-flight: ask the worker to bail. It yields between parse chunks, so it will see this and
						// post an `aborted` response, which settles + pumps the next request (worker stays warm).
						worker.postMessage({ "abort": true, "id": item.id });
					} else {
						// Still queued — reject now; pump() skips it.
						item.reject(new DOMException("classification aborted", "AbortError"));
					}
				}, { "once": true });

				pump();
			});
		},
		"dispose": () => { worker.terminate(); }
	};
}
