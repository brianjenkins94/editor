/**
 * Classify worker — runs BABLR's cosmetic/semantic analysis OFF the main thread, now over the CST-node IDENTITY core.
 *
 * `fileDiffIdentity` restates the verdict on top of stable node identity: cosmetic exactly when the trivia-insensitive
 * node atoms are unchanged, otherwise semantic (a deletion counts), or unparsable. It also yields the working
 * `.bablr` snapshot (nodes with anchored ids) and which nodes changed — returned only when `wantSnapshot` is set, so
 * the badge path stays lightweight while the diff path can persist the sidecar.
 *
 * YIELDING + ABORT: `fileDiffIdentityAsync` paces the BABLR VM (yields as it parses), so an `{ abort }` message can
 * land mid-parse and trip this request's AbortController — the run bails cooperatively, no worker termination. One
 * request in flight at a time (the classifier drives it serially), correlated by id.
 */
import { deriveIdentityAsync, editGroups, fileDiffIdentityAsync } from "@brianjenkins94/bablr";

interface ClassifyRequest { "id": number; "before"?: string; "after"?: string; "contents"?: string[]; "editGroupsContents"?: string[]; "wantSnapshot": boolean }
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

	const { id, before, after, contents, editGroupsContents, wantSnapshot } = data;
	const controller = new AbortController();

	current = { "id": id, "controller": controller };

	try {
		// `editGroupsContents` = a burst chain [HEAD, …afters] ⇒ node-grouped chunks for the "your edits" timeline.
		if (editGroupsContents !== undefined) {
			const grouped = await editGroups(editGroupsContents, { "signal": controller.signal });

			(globalThis as unknown as Worker).postMessage({ "id": id, "groups": grouped.groups, "bursts": grouped.bursts });

			return;
		}

		// `contents` = a windowed commit chain (base…HEAD…working) ⇒ history-anchored identity; otherwise the plain
		// HEAD→working pair. Both yield a verdict; the chain path also anchors node ids to the shared base.
		const result = contents !== undefined
			? await deriveIdentityAsync(contents, { "signal": controller.signal })
			: await fileDiffIdentityAsync(before ?? "", after ?? "", { "signal": controller.signal });
		const reply: Record<string, unknown> = { "id": id, "verdict": result.verdict };

		if (wantSnapshot) {
			reply["changedNodeIds"] = result.changedNodeIds;
			reply["snapshot"] = result.snapshot;
			if ("changedLines" in result) {
				reply["changedLines"] = result.changedLines;
			}
			if ("nodeLines" in result) {
				reply["nodeLines"] = result.nodeLines;
			}
		}

		(globalThis as unknown as Worker).postMessage(reply);
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
