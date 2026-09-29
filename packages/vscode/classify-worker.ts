/**
 * Classify worker — runs BABLR's cosmetic/semantic analysis OFF the main thread, over the CST-node IDENTITY core.
 *
 * `deriveIdentityAsync` restates the verdict on top of stable node identity: cosmetic exactly when the trivia-insensitive
 * node atoms are unchanged, otherwise semantic (a deletion counts), or unparsable — and it also yields which nodes
 * changed and the working lines they land on, so the diff pane can focus per node. `editGroups` decomposes an
 * edit-burst chain into node-grouped chunks for the "your edits" timeline.
 *
 * Served over the hub (see cosmetic-classifier.ts for the client): `classify.verdict` and `classify.editGroups`.
 * YIELDING + ABORT: the derivation paces the BABLR VM (yields as it parses), so a cancelled call's signal lands
 * mid-parse and the run bails cooperatively, no worker termination. The classifier drives one call at a time.
 */
import "./bablr-fast-freeze"; // MUST be first: neutralizes record freezing before the BABLR bundle captures Object.freeze
import { deriveIdentityAsync, editGroups } from "@brianjenkins94/bablr";
import { serve } from "@brianjenkins94/hub";

import { createWorkerHub } from "./worker-hub";

const hub = createWorkerHub("classify");

// A content chain (in practice [HEAD, working]) ⇒ verdict + changed nodes + their working lines.
serve(hub, "classify.verdict", async (args, { signal }) => {
	try {
		const result = await deriveIdentityAsync((args as { "contents": string[] }).contents, { "signal": signal });

		return { "verdict": result.verdict, "changedNodeIds": result.changedNodeIds, "changedLines": "changedLines" in result ? result.changedLines : [] };
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}

		// never let a parse blow up the worker — the caller falls back to a plain diff
		return { "verdict": "unparsable", "changedNodeIds": [], "changedLines": [] };
	}
});

// A burst chain [HEAD, …afters] ⇒ node-grouped chunks for the "your edits" timeline.
serve(hub, "classify.editGroups", async (args, { signal }) => {
	try {
		const { groups, bursts } = await editGroups((args as { "chain": string[] }).chain, { "signal": signal });

		return { "groups": groups, "bursts": bursts };
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}

		return { "groups": [], "bursts": 0 };
	}
});
