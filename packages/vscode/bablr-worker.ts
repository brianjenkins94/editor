/**
 * The BABLR worker — the editor's BABLR, OFF the main thread (bablr.ts starts it and queues what it's asked): the
 * cosmetic/semantic analysis over the CST-node IDENTITY core, and the span ids the runtime evidence keys on.
 *
 * `deriveIdentityAsync` restates the verdict on top of stable node identity: cosmetic exactly when the trivia-insensitive
 * node atoms are unchanged, otherwise semantic (a deletion counts), or unparsable — and it also yields which nodes
 * changed and the working lines they land on, so the diff pane can focus per node. `editGroups` decomposes an
 * edit-burst chain into node-grouped chunks for the "your edits" timeline.
 *
 * Served over the hub: `bablr.verdict` and `bablr.editGroups` (cosmetic-classifier.ts); `bablr.anchors`, the
 * spanAnchors id of each of a source's ranges, for the runtime evidence (evidence.ts); and `bablr.spans`, every span of
 * a source, for showing that evidence on the text as it is now (the insights extension, through worker-pod's
 * `editor.bablr.spans` command).
 * YIELDING + ABORT: the derivation paces the BABLR VM (yields as it parses), so a cancelled call's signal lands
 * mid-parse and the run bails cooperatively, no worker termination. bablr.ts drives one call at a time.
 */
import "./bablr-fast-freeze"; // MUST be first: neutralizes record freezing before the BABLR bundle captures Object.freeze
import { anchorRanges, deriveIdentityAsync, editGroups, spanAnchors } from "@brianjenkins94/bablr";
import { serve } from "@brianjenkins94/hub";

import { createWorkerHub } from "./worker-hub";

const hub = createWorkerHub("bablr");

// A content chain (in practice [HEAD, working]) ⇒ verdict + changed nodes + their working lines.
serve(hub, "bablr.verdict", async (args, { signal }) => {
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
serve(hub, "bablr.editGroups", async (args, { signal }) => {
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

// A source and ranges in it (TypeScript's statements, as a run's coverage gives them) ⇒ each range's spanAnchors id, or
// `unparsable` when BABLR's grammar doesn't take the file (it covers the subset tsval runs, and grows).
serve(hub, "bablr.anchors", (args) => {
	const { source, ranges } = args as { "source": string; "ranges": { "start": number; "end": number }[] };

	try {
		return { "ids": anchorRanges(source, ranges).map((id) => id ?? null) };
	} catch {
		return { "unparsable": true };
	}
});

// A source ⇒ every span of it that can be a handle (punctuation never is: pickAnchor skips it) — its id and offsets.
serve(hub, "bablr.spans", (args) => {
	try {
		return { "spans": (spanAnchors((args as { "source": string }).source) as { "type": string | null; "start": number; "end": number; "id": string }[]).filter((span) => span.type !== null).map(({ id, start, end }) => ({ "id": id, "start": start, "end": end })) };
	} catch {
		return { "unparsable": true };
	}
});
