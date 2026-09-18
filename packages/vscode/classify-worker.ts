/**
 * Classify worker — runs BABLR's cosmetic/semantic analysis OFF the main thread, over the CST-node IDENTITY core.
 *
 * `deriveIdentityAsync` restates the verdict on top of stable node identity: cosmetic exactly when the trivia-insensitive
 * node atoms are unchanged, otherwise semantic (a deletion counts), or unparsable — and it also yields which nodes
 * changed and the working lines they land on, so the diff pane can focus per node. `editGroups` decomposes an
 * edit-burst chain into node-grouped chunks for the "your edits" timeline.
 *
 * YIELDING + ABORT: the derivation paces the BABLR VM (yields as it parses), so an `{ abort }` message can land
 * mid-parse and trip this request's AbortController — the run bails cooperatively, no worker termination. One request
 * in flight at a time (the classifier drives it serially), correlated by id.
 */
import "./bablr-fast-freeze"; // MUST be first: neutralizes record freezing before the BABLR bundle captures Object.freeze
import { deriveIdentityAsync, editGroups } from "@brianjenkins94/bablr";

interface ClassifyRequest { "id": number; "contents"?: string[]; "editGroupsContents"?: string[] }
interface AbortRequest { "abort": true; "id": number }

let current: { "id": number; "controller": AbortController } | undefined;

globalThis.onmessage = async (event: MessageEvent<ClassifyRequest | AbortRequest>): Promise<void> => {
	const data = event.data;

	if ("abort" in data) {
		if (current !== undefined && current.id === data.id) {
			current.controller.abort();
		}

		return;
	}

	const { id, contents, editGroupsContents } = data;
	const controller = new AbortController();

	current = { "id": id, "controller": controller };

	try {
		// `editGroupsContents` = a burst chain [HEAD, …afters] ⇒ node-grouped chunks for the "your edits" timeline.
		if (editGroupsContents !== undefined) {
			const grouped = await editGroups(editGroupsContents, { "signal": controller.signal });

			(globalThis as unknown as Worker).postMessage({ "id": id, "groups": grouped.groups, "bursts": grouped.bursts });

			return;
		}

		// `contents` = a content chain (in practice [HEAD, working]) ⇒ verdict + changed nodes + their working lines.
		const result = await deriveIdentityAsync(contents ?? [], { "signal": controller.signal });

		(globalThis as unknown as Worker).postMessage({
			"id": id,
			"verdict": result.verdict,
			"changedNodeIds": result.changedNodeIds,
			"changedLines": "changedLines" in result ? result.changedLines : []
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			(globalThis as unknown as Worker).postMessage({ "id": id, "aborted": true });
		} else {
			// never let a parse blow up the worker — the caller falls back to a plain diff
			(globalThis as unknown as Worker).postMessage({ "id": id, "verdict": "unparsable" });
		}
	} finally {
		if (current?.id === id) {
			current = undefined;
		}
	}
};
