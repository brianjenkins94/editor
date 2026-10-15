/**
 * Cosmetic-vs-semantic classification service — the reusable seam between BABLR and any consumer.
 *
 * Asks the editor's BABLR worker (bablr.ts — BABLR is a VM interpreter, too slow for the UI thread) for the CST-node
 * IDENTITY analysis. `verdict` is the single classification entry point: the cosmetic/semantic verdict of a HEAD→working change
 * plus which nodes changed and the working lines they land on — everything the changes panes need for both the badge
 * and per-node diff focus. `editGroups` decomposes an edit-burst chain for the "your edits" timeline. Knows NOTHING
 * about git — the git service (git-service.ts) is merely a consumer.
 *
 * CACHING: the slow part of a verdict is parsing its two texts, and the BABLR worker keeps every parse (by blob oid, in
 * its own IndexedDB) — so a verdict over texts it has seen is milliseconds, across reloads too. What's left to cache is
 * the session's answers, in memory, so both changes panes ask once per content pair, not once per pane per refresh.
 *
 * TRANSPORT: the worker serves `bablr.verdict` / `bablr.editGroups` on its own hub, linked to the workbench hub (so the
 * calls are visible on the architecture view). bablr.ts queues them, one at a time, behind its other callers' — and
 * passes on cancellation: aborting a call stops it mid-parse, or drops it unsent while it's still queued.
 *
 * Its verdicts are everyone's on the hub as `annotations.classify` { before, after }: the shell's review panel asks it,
 * and so does the bridge's `editor.annotations.classify` (the cosmetic extension's badge, any extension's) — editor-api's
 * Answer, as the other annotations are. No git here: whoever asks has the two texts.
 */
import type { ChangeVerdict } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { Bablr } from "./bablr";
import { serve } from "@brianjenkins94/hub";

/** A change's verdict + the changed node ids and the working lines they land on — the badge AND the diff-focus data. */
export type VerdictEntry = ChangeVerdict;

export interface CosmeticClassifier {
	/** The verdict of a change + its changed-node detail. Cached in memory for the session. Pass an
	 *  `AbortSignal` to cancel a superseded request; the promise then rejects with an AbortError. */
	"verdict": (before: string, after: string, signal?: AbortSignal) => Promise<VerdictEntry>;
	/** Node-grouped chunks for the "your edits" timeline, over a burst chain [HEAD, …afters] → groups + burst count. */
	"editGroups": (chain: string[], signal?: AbortSignal) => Promise<{ "groups": EditGroup[]; "bursts": number }>;
}

/** One node-grouped chunk for the "your edits" timeline — mirrors bablr's EditGroup (kept local to avoid a type dep). */
export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

/** FNV-1a 32-bit — a cheap key for the in-memory cache. */
function fnv32(text: string): number {
	let hash = 0x811C9DC5;

	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return hash >>> 0;
}

/** Create a classifier over the editor's BABLR worker (bablr.ts), answering `annotations.classify` on `hub`. */
export function createCosmeticClassifier(bablr: Bablr, hub: Hub): CosmeticClassifier {
	const request = <T>(name: string, args: unknown, signal: AbortSignal | undefined): Promise<T> => bablr.request<T>(name, args, signal);

	// The session's verdicts — keyed by a cheap content-pair hash.
	const memo = new Map<string, VerdictEntry>();
	const memoKey = (before: string, after: string): string => before.length + ":" + after.length + ":" + fnv32(before) + ":" + fnv32(after);

	const classifier: CosmeticClassifier = {
		"verdict": async (before, after, signal) => {
			if (before === after) {
				return { "verdict": "cosmetic", "changedNodeIds": [], "changedLines": [] }; // identical — the only provably-correct shortcut
			}

			const key = memoKey(before, after);
			const hit = memo.get(key);

			if (hit !== undefined) {
				return hit;
			}

			// Derive over [HEAD, working]: verdict + changed nodes + their working lines (from the worker's cached parses).
			const entry = await request<VerdictEntry>("verdict", { "contents": [before, after] }, signal);

			if (memo.size > 200) {
				memo.clear();
			}

			memo.set(key, entry);

			return entry;
		},
		"editGroups": (chain, signal) => request("editGroups", { "chain": chain }, signal)
	};

	serve(hub, "annotations.classify", async (args) => {
		const { before, after } = (args ?? {}) as { "before"?: unknown; "after"?: unknown };

		if (typeof before !== "string" || typeof after !== "string") {
			throw new TypeError("annotations.classify: the two texts");
		}

		try {
			return { "value": await classifier.verdict(before, after) };
		} catch (error) {
			return { "unparsable": error instanceof Error ? error.message : "BABLR can't read the texts" };
		}
	});

	return classifier;
}
