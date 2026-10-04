/**
 * Cosmetic-vs-semantic classification service — the reusable seam between BABLR and any consumer.
 *
 * Asks the editor's BABLR worker (bablr.ts — BABLR is a VM interpreter, too slow for the UI thread) for the CST-node
 * IDENTITY analysis. `verdict` is the single classification entry point: the cosmetic/semantic verdict of a HEAD→working change
 * plus which nodes changed and the working lines they land on — everything the changes panes need for both the badge
 * and per-node diff focus. `editGroups` decomposes an edit-burst chain for the "your edits" timeline. Knows NOTHING
 * about git — the git service (git-service.ts) is merely a consumer.
 *
 * CACHING: a verdict is a pure, deterministic function of the (before, after) content pair, so it is READ-THROUGH
 * cached — an in-memory tier for the session, then an optional injected `VerdictStore` (BABLR's cache, bablr.ts: keyed
 * by blob oids in `.silo/local/bablr/verdicts/`, durable across reloads) — and BABLR (slow) runs only on a true miss. Both changes panes share this one
 * cache, so a file is classified once per content pair, not once per pane per refresh.
 *
 * TRANSPORT: the worker serves `bablr.verdict` / `bablr.editGroups` on its own hub, linked to the workbench hub (so the
 * calls are visible on the architecture view). bablr.ts queues them, one at a time, behind its other callers' — and
 * passes on cancellation: aborting a call stops it mid-parse, or drops it unsent while it's still queued.
 */
import type { Bablr } from "./bablr";

/** BABLR's verdict for a change (mirrors `@brianjenkins94/bablr`). */
export type ChangeKind = "cosmetic" | "semantic" | "unparsable";

/** A change's verdict + the changed node ids and the working lines they land on — the badge AND the diff-focus data. */
export interface VerdictEntry { "verdict": ChangeKind | "none"; "changedNodeIds": string[]; "changedLines": number[] }

/**
 * Durable, content-addressed backing for the verdict cache (bablr.ts's, in `.silo/local/bablr/verdicts/`). Optional — without it the
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
	"editGroups": (chain: string[], signal?: AbortSignal) => Promise<{ "groups": EditGroup[]; "bursts": number }>;
}

/** One node-grouped chunk for the "your edits" timeline — mirrors bablr's EditGroup (kept local to avoid a type dep). */
export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

/** FNV-1a 32-bit — a cheap key for the in-memory tier (the durable store keys by collision-free git blob oid). */
function fnv32(text: string): number {
	let h = 0x811c9dc5;

	for (let index = 0; index < text.length; index += 1) {
		h ^= text.charCodeAt(index);
		h = Math.imul(h, 0x01000193);
	}

	return h >>> 0;
}

/** Create a classifier over the editor's BABLR worker (bablr.ts), optionally persisting verdicts through `store` for a
 *  durable, cross-reload cache. */
export function createCosmeticClassifier(bablr: Bablr, store?: VerdictStore): CosmeticClassifier {
	const request = <T>(name: string, args: unknown, signal: AbortSignal | undefined): Promise<T> => bablr.request<T>(name, args, signal);

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
			const entry = await request<VerdictEntry>("verdict", { "contents": [before, after] }, signal);

			if (memo.size > 200) {
				memo.clear();
			}

			memo.set(key, entry);
			void store?.write(before, after, entry).catch(() => { /* best-effort durability — never block the answer */ });

			return entry;
		},
		"editGroups": (chain, signal) => request("editGroups", { "chain": chain }, signal)
	};
}
