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
import { fileDiffIdentityAsync } from "@brianjenkins94/bablr";

interface ClassifyRequest { "id": number; "before": string; "after": string; "wantSnapshot": boolean }
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

	const { id, before, after, wantSnapshot } = data;
	const controller = new AbortController();

	current = { "id": id, "controller": controller };

	try {
		const result = await fileDiffIdentityAsync(before, after, { "signal": controller.signal });
		const reply: Record<string, unknown> = { "id": id, "verdict": result.verdict };

		if (wantSnapshot) {
			reply["changedNodeIds"] = result.changedNodeIds;
			reply["snapshot"] = result.snapshot;
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
