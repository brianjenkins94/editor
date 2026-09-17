/**
 * Cosmetic-vs-semantic classification service — the reusable seam between BABLR and any consumer.
 *
 * Owns the classify worker (BABLR is a VM interpreter, too slow for the UI thread) and runs the CST-node IDENTITY
 * analysis: `classify` returns just the verdict (for SCM badges); `analyze` also returns which nodes changed and the
 * working `.bablr` snapshot (nodes with anchored ids) so the caller can persist a sidecar and, later, highlight
 * per-node changes. Knows NOTHING about git or SCM — the git SCM binding (`git-scm.ts`) is merely one consumer.
 *
 * ABORT: the worker yields between parse chunks, so its message loop can see an `{ abort }` message mid-run. The
 * classifier drives ONE request at a time (a serial queue); to cancel the running one it posts an abort for that id
 * and the worker bails cooperatively (worker stays warm — no termination). Aborting a still-queued request drops it.
 *
 * NOTE: no verdict cache. A content-derived key can be wrong; the correct key is a STABLE NODE IDENTITY — which is
 * exactly what `analyze`'s snapshot now provides, and what a future .bablr-keyed cache will use.
 */

/** BABLR's verdict for a change (mirrors `@brianjenkins94/bablr`). */
export type ChangeKind = "cosmetic" | "semantic" | "unparsable";

/** The identity analysis of a change: verdict + changed node ids + the working `.bablr` snapshot. */
export interface FileAnalysis {
	"verdict": ChangeKind | "none";
	"changedNodeIds": string[];
	"snapshot": unknown;
}

export interface CosmeticClassifier {
	/** Just the verdict (SCM badges). Pass an `AbortSignal` to cancel; the promise then rejects with an AbortError. */
	"classify": (before: string, after: string, signal?: AbortSignal) => Promise<ChangeKind | "none">;
	/** HEAD→working analysis: verdict + changed node ids + the working `.bablr` snapshot. */
	"analyze": (before: string, after: string, signal?: AbortSignal) => Promise<FileAnalysis>;
	/** Derive over a windowed commit chain (base…HEAD…working) → HISTORY-ANCHORED snapshot + verdict + changes. */
	"identify": (contents: string[], signal?: AbortSignal) => Promise<FileAnalysis>;
	/** Tear down the worker. */
	"dispose": () => void;
}

interface ClassifyResponse { "id": number; "verdict"?: ChangeKind | "none"; "changedNodeIds"?: string[]; "snapshot"?: unknown; "aborted"?: true }

interface RequestMessage { "before"?: string; "after"?: string; "contents"?: string[] }

interface QueueItem {
	"id": number;
	"message": RequestMessage;
	"wantSnapshot": boolean;
	"resolve": (result: FileAnalysis) => void;
	"reject": (error: unknown) => void;
	"aborted": boolean;
}

/** Create a classifier backed by the BABLR classify worker (served at `lsp/classify-worker.js`). */
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

		if (event.data.aborted === true || event.data.verdict === undefined) {
			settled.reject(new DOMException("classification aborted", "AbortError"));
		} else {
			settled.resolve({ "verdict": event.data.verdict, "changedNodeIds": event.data.changedNodeIds ?? [], "snapshot": event.data.snapshot ?? null });
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
		worker.postMessage({ "id": next.id, ...next.message, "wantSnapshot": next.wantSnapshot });
	}

	const request = async (message: RequestMessage, signal: AbortSignal | undefined, wantSnapshot: boolean): Promise<FileAnalysis> => {
		if (message.contents === undefined && message.before === message.after) {
			return { "verdict": "cosmetic", "changedNodeIds": [], "snapshot": null }; // identical — the only provably-correct shortcut
		}

		if (signal?.aborted === true) {
			throw new DOMException("classification aborted", "AbortError");
		}

		return new Promise<FileAnalysis>((resolve, reject) => {
			const item: QueueItem = { "id": nextId, "message": message, "wantSnapshot": wantSnapshot, "resolve": resolve, "reject": reject, "aborted": false };

			nextId += 1;
			queue.push(item);

			signal?.addEventListener("abort", () => {
				if (item.aborted) {
					return;
				}

				item.aborted = true;

				if (running === item) {
					// Mid-flight: ask the worker to bail (it yields between parse chunks) — it posts `aborted`, which
					// settles + pumps the next request, keeping the worker warm.
					worker.postMessage({ "abort": true, "id": item.id });
				} else {
					item.reject(new DOMException("classification aborted", "AbortError")); // queued — pump() skips it
				}
			}, { "once": true });

			pump();
		});
	};

	return {
		"classify": async (before, after, signal) => (await request({ "before": before, "after": after }, signal, false)).verdict,
		"analyze": (before, after, signal) => request({ "before": before, "after": after }, signal, true),
		"identify": (contents, signal) => request({ "contents": contents }, signal, true),
		"dispose": () => { worker.terminate(); }
	};
}
