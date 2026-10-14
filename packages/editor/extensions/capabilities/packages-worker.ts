/**
 * The package worker: what each dependency's own code can do, read off its published tarball by lib's one package
 * analysis (packageCaps: its code files, and its install hooks) — off the extension host. The capabilities extension
 * starts it to sync the baseline (baseline.ts) and ends it after, so no tarball's bytes or text outlive the sync.
 *
 * Asked over its own channel: `{ id, url }` → `{ id, caps }` or `{ id, error }`. Started through a one-line bootstrap
 * that imports this module (an extension's workers start classic), which says `{ failed }` if it couldn't load; this
 * says `{ ready }` once it listens — a request sent before then would be lost.
 */
import { unpack } from "@brianjenkins94/almostnode/packages";
import { packageCaps } from "@brianjenkins94/util/silo/detect";

/** What packageCaps reads: code files and the manifest (only these are decoded). */
const READ = /(?:\.[cm]?js|^package\.json)$/u;

globalThis.addEventListener("message", (event: MessageEvent) => {
	const { id, url } = event.data as { "id": number; "url": string };

	void (async () => {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`${response.status} from ${url}`);
			}

			const decoder = new TextDecoder();
			const files = [...unpack(new Uint8Array(await response.arrayBuffer()))].filter(([path]) => READ.test(path)).map(([path, bytes]) => [path, decoder.decode(bytes)] as const);

			globalThis.postMessage({ "id": id, "caps": packageCaps(files) });
		} catch (error) {
			globalThis.postMessage({ "id": id, "error": error instanceof Error ? error.message : String(error) });
		}
	})();
});

globalThis.postMessage({ "ready": true });
