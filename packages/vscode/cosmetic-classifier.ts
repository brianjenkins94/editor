/**
 * Cosmetic-vs-semantic classification service — the reusable seam between BABLR and any consumer.
 *
 * Owns the classify worker (BABLR is a VM interpreter, too slow for the UI thread) and runs the CST-node IDENTITY
 * analysis. `verdict` is the single classification entry point: the cosmetic/semantic verdict of a HEAD→working change
 * plus which nodes changed and the working lines they land on — everything the changes panes need for both the badge
 * and per-node diff focus. `editGroups` decomposes an edit-burst chain for the "your edits" timeline. Knows NOTHING
 * about git — the git bindings (git-scm.ts, git-service.ts) are merely consumers.
 *
 * CACHING: a verdict is a pure, deterministic function of the (before, after) content pair, so it is READ-THROUGH
 * cached — an in-memory tier for the session, then an optional injected `VerdictStore` (git-engine's content-addressed
 * `.git/bablr/`, durable across reloads) — and BABLR (slow) runs only on a true miss. Both changes panes share this one
 * cache, so a file is classified once per content pair, not once per pane per refresh.
 *
 * ABORT: the worker yields between parse chunks, so its message loop can see an `{ abort }` message mid-run. The
 * classifier drives ONE request at a time (a serial queue); to cancel the running one it posts an abort for that id
 * and the worker bails cooperatively (worker stays warm — no termination). Aborting a still-queued request drops it.
 */

/** BABLR's verdict for a change (mirrors `@brianjenkins94/bablr`). */
export type ChangeKind = "cosmetic" | "semantic" | "unparsable";

/** A change's verdict + the changed node ids and the working lines they land on — the badge AND the diff-focus data. */
export interface VerdictEntry { "verdict": ChangeKind | "none"; "changedNodeIds": string[]; "changedLines": number[] }

/**
 * Durable, content-addressed backing for the verdict cache (git-engine's `.git/bablr/`). Optional — without it the
 * classifier still caches in memory for the session. Keyed by the two contents (the store hashes them, e.g. to git
 * blob oids), so a hit is provably the same inputs.
 */
export interface VerdictStore {
	"read": (before: string, after: string) => Promise<VerdictEntry | null>;
	"write": (before: string, after: string, entry: VerdictEntry) => Promise<void>;
}

export interface CosmeticClassifier {
	/** The verdict of a change + its changed-node detail. Read-through cached (memory → store → BABLR). Pass an
	 *  `AbortSignal` to cancel a superseded request; the promise then rejects with an AbortError. */
	"verdict": (before: string, after: string, signal?: AbortSignal) => Promise<VerdictEntry>;
	/** Node-grouped chunks for the "your edits" timeline, over a burst chain [HEAD, …afters] → groups + burst count. */
	"editGroups": (contents: string[], signal?: AbortSignal) => Promise<{ "groups": EditGroup[]; "bursts": number }>;
	/** Tear down the worker. */
	"dispose": () => void;
}

/** One node-grouped chunk for the "your edits" timeline — mirrors bablr's EditGroup (kept local to avoid a type dep). */
export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

interface ClassifyResponse { "id": number; "verdict"?: ChangeKind | "none"; "changedNodeIds"?: string[]; "changedLines"?: number[]; "groups"?: EditGroup[]; "bursts"?: number; "aborted"?: true }

interface RequestMessage { "contents"?: string[]; "editGroupsContents"?: string[] }

/** The raw worker reply the queue resolves; each public method projects the fields it needs. */
interface WorkerResult { "verdict": ChangeKind | "none"; "changedNodeIds": string[]; "changedLines": number[]; "groups": EditGroup[]; "bursts": number }

interface QueueItem {
	"id": number;
	"message": RequestMessage;
	"resolve": (result: WorkerResult) => void;
	"reject": (error: unknown) => void;
	"aborted": boolean;
}

/** FNV-1a 32-bit — a cheap key for the in-memory tier (the durable store keys by collision-free git blob oid). */
function fnv32(text: string): number {
	let h = 0x811c9dc5;

	for (let index = 0; index < text.length; index += 1) {
		h ^= text.charCodeAt(index);
		h = Math.imul(h, 0x01000193);
	}

	return h >>> 0;
}

/** Create a classifier backed by the BABLR classify worker (served at `lsp/classify-worker.js`), optionally persisting
 *  verdicts through `store` for a durable, cross-reload cache. */
export function createCosmeticClassifier(store?: VerdictStore): CosmeticClassifier {
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

		// An editGroups reply carries no verdict — only `aborted` means "bailed"; otherwise resolve (verdict defaults).
		if (event.data.aborted === true) {
			settled.reject(new DOMException("classification aborted", "AbortError"));
		} else {
			settled.resolve({ "verdict": event.data.verdict ?? "none", "changedNodeIds": event.data.changedNodeIds ?? [], "changedLines": event.data.changedLines ?? [], "groups": event.data.groups ?? [], "bursts": event.data.bursts ?? 0 });
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
		worker.postMessage({ "id": next.id, ...next.message });
	}

	const request = async (message: RequestMessage, signal: AbortSignal | undefined): Promise<WorkerResult> => {
		if (signal?.aborted === true) {
			throw new DOMException("classification aborted", "AbortError");
		}

		return new Promise<WorkerResult>((resolve, reject) => {
			const item: QueueItem = { "id": nextId, "message": message, "resolve": resolve, "reject": reject, "aborted": false };

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

	// The verdict cache's in-memory tier — keyed by a cheap content-pair hash (the durable store keys by git blob oid).
	const memo = new Map<string, VerdictEntry>();
	const memoKey = (before: string, after: string): string => before.length + ":" + after.length + ":" + fnv32(before) + ":" + fnv32(after);

	return {
		"verdict": async (before, after, signal) => {
			if (before === after) {
				return { "verdict": "cosmetic", "changedNodeIds": [], "changedLines": [] }; // identical — the only provably-correct shortcut
			}

			const key = memoKey(before, after);
			const hit = memo.get(key);

			if (hit !== undefined) {
				return hit;
			}

			// Durable tier: a content-addressed hit means genuinely identical inputs, so skip BABLR entirely.
			const persisted = store === undefined ? null : await store.read(before, after);

			if (persisted !== null && persisted !== undefined) {
				memo.set(key, persisted);

				return persisted;
			}

			// True miss — derive over [HEAD, working]: verdict + changed nodes + their working lines. Then cache both tiers.
			const result = await request({ "contents": [before, after] }, signal);
			const entry: VerdictEntry = { "verdict": result.verdict, "changedNodeIds": result.changedNodeIds, "changedLines": result.changedLines };

			if (memo.size > 200) {
				memo.clear();
			}

			memo.set(key, entry);
			void store?.write(before, after, entry).catch(() => { /* best-effort durability — never block the answer */ });

			return entry;
		},
		"editGroups": async (contents, signal) => { const result = await request({ "editGroupsContents": contents }, signal); return { "groups": result.groups, "bursts": result.bursts }; },
		"dispose": () => { worker.terminate(); }
	};
}
