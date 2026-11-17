/**
 * rolldown, for a run's packages (Vite's): the browser build the editor bundles, `@rolldown/browser` — its WebAssembly and
 * its threads' worker served beside this worker (build.ts) — in place of the native package, whose binding a browser
 * can't load. Loaded before a run that reaches it (session.ts), since a package's require of it can't wait, and kept for
 * the worker's runs after; each subpath Vite imports, the browser build's own of the same name.
 */

/** Each subpath, and its browser build's (the ones Vite imports: the same names, the same exports). */
const SUBPATHS: Record<string, () => Promise<unknown>> = {
	"rolldown": async () => import("@rolldown/browser"),
	"rolldown/experimental": async () => import("@rolldown/browser/experimental"),
	"rolldown/filter": async () => import("@rolldown/browser/filter"),
	"rolldown/parseAst": async () => import("@rolldown/browser/parseAst"),
	"rolldown/plugins": async () => import("@rolldown/browser/plugins"),
	"rolldown/utils": async () => import("@rolldown/browser/utils")
};

let loaded: Promise<Map<string, unknown>> | undefined;
let ready: Map<string, unknown> | undefined;

/** Whether `specifier` is one of rolldown's. */
export const isRolldown = (specifier: string): boolean => specifier === "rolldown" || specifier.startsWith("rolldown/");

/** The browser build loaded, each subpath it has (once a worker): what it can't load is said, and left to the package's own
 *  (which then says why it can't, as it's required). */
export async function loadRolldown(): Promise<string[]> {
	const failed: string[] = [];

	loaded ??= Promise.all(Object.entries(SUBPATHS).map(async ([id, load]): Promise<[string, unknown] | undefined> => {
		try {
			return [id, await load()];
		} catch (error) {
			failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);

			return undefined;
		}
	})).then((entries) => new Map(entries.filter((entry) => entry !== undefined)));
	ready = await loaded;

	return failed;
}

/** rolldown's `specifier`, as the browser build has it, once it's loaded (else undefined: the package's own). */
export function rolldownFor(specifier: string): unknown {
	return ready?.get(specifier);
}
