/**
 * The BABLR worker — the editor's BABLR, OFF the main thread (bablr.ts starts it and queues what it's asked): the
 * cosmetic/semantic analysis over the CST-node IDENTITY core, and the span ids the runtime evidence keys on.
 *
 * `deriveIdentityAsync` restates the verdict on top of stable node identity: cosmetic exactly when the trivia-insensitive
 * node atoms are unchanged, otherwise semantic (a deletion counts), or unparsable — and it also yields which nodes
 * changed and the working lines they land on, so the diff pane can focus per node. `editGroups` decomposes an
 * edit-burst chain into node-grouped chunks for the "your edits" timeline.
 *
 * Served over the hub, to bablr.ts: `bablr.verdict` and `bablr.editGroups` (cosmetic-classifier.ts); `bablr.spans`,
 * every span of a source (cached by bablr.ts); and `bablr.pick`, the span standing for each of a text's ranges, from its
 * spans (the runtime evidence's span ids for a run's statements).
 * YIELDING + ABORT: the derivation paces the BABLR VM (yields as it parses), so a cancelled call's signal lands
 * mid-parse and the run bails cooperatively, no worker termination. bablr.ts drives one call at a time.
 */
import "./bablr-fast-freeze"; // MUST be first: neutralizes record freezing before the BABLR bundle captures Object.freeze
import { deriveIdentityAsync, editGroups, pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
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

// A source ⇒ every span of it that can be a handle (punctuation never is: pickAnchor skips it) — its id and offsets — or
// `unparsable` when BABLR's grammar doesn't take it (it covers the subset tsval runs, and grows). bablr.ts caches it.
serve(hub, "bablr.spans", (args) => {
	try {
		return { "spans": (spanAnchors((args as { "source": string }).source) as { "type": string | null; "start": number; "end": number; "id": string }[]).filter((span) => span.type !== null).map(({ id, start, end }) => ({ "id": id, "start": start, "end": end })) };
	} catch {
		return { "unparsable": true };
	}
});

// A text's spans (bablr.spans, cached) and ranges in it — TypeScript's statements, as a run's coverage gives them ⇒ the
// span standing for each range (pickAnchor). No parse: the spans are given.
serve(hub, "bablr.pick", (args) => {
	const { spans, ranges } = args as { "spans": { "id": string; "start": number; "end": number }[]; "ranges": { "start": number; "end": number }[] };
	const handles = spans.map((span) => ({ ...span, "type": "" }));

	return { "ids": ranges.map((range) => pickAnchor(handles, range.start, range.end) ?? null) };
});
