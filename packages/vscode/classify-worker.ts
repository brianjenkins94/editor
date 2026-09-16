/**
 * Classify worker — runs BABLR's `classifyChange` (cosmetic vs semantic) OFF the main thread.
 *
 * BABLR is a VM interpreter: parsing a file is tens-to-hundreds of ms (it parses BOTH versions), far too slow for
 * the workbench thread. So a caller posts (before, after) here and gets the verdict back.
 *
 * YIELDING + ABORT: we use `classifyChangeAsync`, which PACES the BABLR VM (yields to the event loop as it parses)
 * instead of blocking the worker straight through. Because the worker's message loop runs between those yields, an
 * `{ abort }` message can land mid-parse; we trip that request's AbortController and the run bails cooperatively —
 * no worker termination, so the cache and warm state survive. One request in flight at a time (the classifier drives
 * it serially), correlated by id.
 */
import { classifyChangeAsync } from "@brianjenkins94/bablr";

interface ClassifyRequest { "id": number; "before": string; "after": string }
interface AbortRequest { "abort": true; "id": number }
interface ClassifyResponse { "id": number; "kind": "cosmetic" | "semantic" | "unparsable" }
interface AbortedResponse { "id": number; "aborted": true }

let current: { "id": number; "controller": AbortController } | undefined;

globalThis.onmessage = async (event: MessageEvent<ClassifyRequest | AbortRequest>): Promise<void> => {
	const data = event.data;

	if ("abort" in data) {
		if (current !== undefined && current.id === data.id) {
			current.controller.abort();
		}

		return;
	}

	const { id, before, after } = data;
	const controller = new AbortController();

	current = { "id": id, "controller": controller };

	try {
		const kind = await classifyChangeAsync(before, after, "Program", { "signal": controller.signal });

		(globalThis as unknown as Worker).postMessage({ "id": id, "kind": kind } satisfies ClassifyResponse);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			(globalThis as unknown as Worker).postMessage({ "id": id, "aborted": true } satisfies AbortedResponse);
		} else {
			// never let a parse blow up the worker — the caller falls back to a plain diff
			(globalThis as unknown as Worker).postMessage({ "id": id, "kind": "unparsable" } satisfies ClassifyResponse);
		}
	} finally {
		if (current?.id === id) {
			current = undefined;
		}
	}
};
