/**
 * Classify worker — runs BABLR's `classifyChange` (cosmetic vs semantic) OFF the main thread.
 *
 * BABLR is a VM interpreter: parsing a file is tens-to-hundreds of ms (it parses BOTH the HEAD and working
 * versions), far too slow to run on the workbench thread during an SCM refresh. So the git SCM posts each changed
 * file's (before, after) here and paints the "cosmetic only" badge when the verdict comes back. Plain postMessage
 * (no hub) — one request in, one verdict out, correlated by id.
 */
import { classifyChange } from "@brianjenkins94/bablr";

interface ClassifyRequest { "id": number; "before": string; "after": string }
interface ClassifyResponse { "id": number; "kind": "cosmetic" | "semantic" | "unparsable" }

globalThis.onmessage = (event: MessageEvent<ClassifyRequest>): void => {
	const { id, before, after } = event.data;
	let kind: ClassifyResponse["kind"];

	try {
		kind = classifyChange(before, after);
	} catch {
		kind = "unparsable"; // never let a parse blow up the worker — the caller falls back to a plain diff
	}

	(globalThis as unknown as Worker).postMessage({ "id": id, "kind": kind } satisfies ClassifyResponse);
};
