import type { Rolldown } from "@brianjenkins94/util/silo/slice";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { packageCaps } from "@brianjenkins94/util/silo/detect";

const READ = /(?:\.[cm]?js|^package\.json)$/u;

interface Slice { "key": string; "spec": string; "members": string[] }

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
