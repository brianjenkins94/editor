/**
 * The package worker: what each dependency's own code can do, read off its published tarball — the whole package (lib's
 * packageCaps: its code files, and its install hooks), and the join: what the part of it the code uses can reach (lib's
 * sliceCaps, rolldown's browser build tree-shaking the tarball's files from the members the code imports). Off the
 * extension host: the capabilities extension starts it to sync the baseline (baseline.ts) and ends it after, so no
 * tarball's bytes or text, nor the bundler, outlive the sync.
 *
 * Asked over its own channel: `{ id, url, slices? }` → `{ id, caps, slices }` (each slice's capabilities by its key, null
 * where none could be built — the whole package stands) or `{ id, error }`. Started through a one-line bootstrap that
 * imports this module (an extension's workers start classic), which says `{ failed }` if it couldn't load; this says
 * `{ ready }` once it listens — a request sent before then would be lost.
 */
import type { Rolldown } from "@brianjenkins94/util/silo/slice";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { packageCaps } from "@brianjenkins94/util/silo/detect";

/** What a slice reads: code files and the manifest (only these are decoded). */
const READ = /(?:\.[cm]?js|^package\.json)$/u;

/** One slice to read: its key (the caller's), the specifier the code imports, and the members it uses of it. */
interface Slice { "key": string; "spec": string; "members": string[] }

/** What slices: lib's sliceCaps and rolldown's browser build, loaded on the first slice (rolldown's wasm is large: a sync
 *  that slices nothing never loads it). Both read `process`, which a worker has none of: the build gives each of this
 *  worker's chunks the shim (build.ts). */
let slicer: Promise<{ "rolldown": Rolldown; "sliceCaps": typeof import("@brianjenkins94/util/silo/slice").sliceCaps }> | undefined;

function loadSlicer(): NonNullable<typeof slicer> {
	return Promise.all([import("@rolldown/browser"), import("@brianjenkins94/util/silo/slice")]).then(([bundler, slice]) => ({ "rolldown": bundler.rolldown as unknown as Rolldown, "sliceCaps": slice.sliceCaps }));
}

globalThis.addEventListener("message", (event: MessageEvent) => {
	const { id, url, name, slices = [] } = event.data as { "id": number; "url": string; "name"?: string; "slices"?: Slice[] };

	void (async () => {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`${response.status} from ${url}`);
			}

			const decoder = new TextDecoder();
			const files = new Map([...unpack(new Uint8Array(await response.arrayBuffer()))].filter(([path]) => READ.test(path)).map(([path, bytes]) => [path, decoder.decode(bytes)] as const));
			const sliced: Record<string, string[] | null> = {};

			if (slices.length > 0 && name !== undefined) {
				slicer ??= loadSlicer();

				const { rolldown, sliceCaps } = await slicer;

				for (const slice of slices) {
					sliced[slice.key] = await sliceCaps(rolldown, name, files, slice.spec, slice.members) ?? null;
				}
			}

			globalThis.postMessage({ "id": id, "caps": packageCaps(files), "slices": sliced });
		} catch (error) {
			globalThis.postMessage({ "id": id, "error": error instanceof Error ? error.message : String(error) });
		}
	})();
});

globalThis.postMessage({ "ready": true });
