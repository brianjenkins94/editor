/**
 * CDN-backed, read-only, *eventually-consistent* filesystem provider for node_modules.
 *
 * The other half of the resolution stack: the synchronous snapshot (snapshot.ts → editorTypesPlugin)
 * seeds the .d.ts surface the TS type-checker needs up front; this overlay lazily fetches FULL package
 * source from unpkg on demand so go-to-definition / hover reaches the real implementation (and
 * transitive deps) without baking any of it into the page. It works in a static deploy (no filesystem).
 *
 * Registered as a low-priority `file` overlay: it only answers `<workspaceFolder>/node_modules/<pkg>/…`
 * and throws FileNotFound otherwise, so the in-memory snapshot wins for everything else (the overlay
 * falls through on FileNotFound). Built from primitives re-exported by
 * `@brianjenkins94/monaco-vscode-api/main` so editor doesn't depend on @codingame packages directly.
 *
 * Note: this satisfies go-to-definition/browsing into CDN deps, but NOT the TS type-checker, which
 * resolves package.json/exports against a synchronous worker view the async provider can't populate —
 * type-checked source imports must be seeded synchronously instead (editorTypesPlugin).
 */
import type { IFileChange, IFileSystemProviderWithFileReadWriteCapability, IStat } from "@brianjenkins94/monaco-vscode-api/main";
import {
	FileChangeType,
	FileSystemProviderCapabilities,
	FileType
} from "@brianjenkins94/monaco-vscode-api/main";
import { createChangeEvent, notFound, readOnly, relUnder } from "./provider-base";

interface UnpkgMeta {
	"type": "file" | "directory";
	"size"?: number;
	"files"?: { "path": string; "type": "file" | "directory"; "size"?: number }[];
}

/** Split a node_modules-relative path into package + subpath, honouring scopes (@scope/name). */
function splitPackage(rel: string): { "pkg": string; "sub": string } {
	const parts = rel.split("/");
	const count = parts[0]?.startsWith("@") ? 2 : 1;

	return { "pkg": parts.slice(0, count).join("/"), "sub": parts.slice(count).join("/") };
}

export function createNodeModulesProvider(workspaceFolder: string, versions: Record<string, string>): IFileSystemProviderWithFileReadWriteCapability {
	const prefix = workspaceFolder.replace(/\/$/u, "") + "/node_modules";
	// The deploy base ("/editor/" on GitHub Pages, "/" locally): this provider runs in the workbench iframe at
	// <base>/__vscode__/host.html, and the service worker is scoped to <base>, so requests must sit under <base>
	// to be intercepted (the SW matches /workspace/ under any prefix — see coi-serviceworker.js). A root-absolute
	// /workspace/… URL would escape the SW scope on a subpath deploy.
	const deployBase = location.pathname.slice(0, location.pathname.indexOf("/__vscode__/") + 1) || "/";

	const { listeners, onDidChangeFile } = createChangeEvent();
	const announced = new Set<string>();
	const announce = (resource: { "toString": () => string }, change: IFileChange): void => {
		const key = resource.toString();

		if (announced.has(key)) {
			return; // once per resource — enough to make TS re-resolve
		}

		announced.add(key);
		for (const listener of [...listeners]) {
			listener([change]);
		}
	};

	const toRel = relUnder(prefix);

	// Only packages with a pinned version are served. The CDN 302-redirects every *unversioned* request
	// (e.g. `unpkg.com/preact` → `…/preact@10.x`); the resolver's CDN fallback follows that redirect
	// internally (its fetch isn't bound by the document's COEP), but we still can't pin a version
	// synchronously, so we simply don't fetch unpinned packages (type-checking uses the synchronous
	// snapshot, not this provider).
	const served = (rel: string): boolean => versions[splitPackage(rel).pkg] !== undefined;

	// Promise-memoized by URL (meta and file requests differ by the `?meta` suffix). Cache 404s (real
	// misses) and successes; let transient failures (network/5xx/429) retry.
	const cache = new Map<string, Promise<unknown>>();
	const memoFetch = <T>(rel: string, query: string, parse: (res: Response) => Promise<T>): Promise<T | undefined> => {
		if (!served(rel)) {
			return Promise.resolve(undefined);
		}

		// Fetch the REAL same-origin node_modules path. A store miss there is answered by the resolver's CDN
		// fallback — the SW (prod) or vite.ts nodeModulesCdnPlugin (dev) fetches the package from the CDN and
		// hands it back same-origin (the fold-in that retired `__proxy__`; see coi-serviceworker.js). The
		// pinned version rides along as `?v=` so the served source matches the type-checker snapshot's version;
		// `?meta` asks for the directory listing. `served()` above guarantees the version is defined here.
		const version = versions[splitPackage(rel).pkg];
		const search = query === "?meta" ? `?meta&v=${version}` : `?v=${version}`;
		const url = new URL(`${deployBase}${prefix.replace(/^\//u, "")}/${rel}${search}`, location.href).href;

		if (!cache.has(url)) {
			cache.set(url, fetch(url)
				.then(async (res) => {
					if (res.ok) {
						return parse(res);
					}

					if (res.status === 404) {
						return undefined;
					}

					cache.delete(url);

					return undefined;
				})
				.catch(() => {
					cache.delete(url);

					return undefined;
				}));
		}

		return cache.get(url) as Promise<T | undefined>;
	};

	const fetchMeta = (rel: string): Promise<UnpkgMeta | undefined> => memoFetch(rel, "?meta", (res) => res.json() as Promise<UnpkgMeta>);
	const fetchFile = (rel: string): Promise<Uint8Array | undefined> => memoFetch(rel, "", async (res) => new Uint8Array(await res.arrayBuffer()));

	return {
		"capabilities":
			FileSystemProviderCapabilities.FileReadWrite
			| FileSystemProviderCapabilities.PathCaseSensitive
			| FileSystemProviderCapabilities.Readonly,
		"onDidChangeCapabilities": (() => ({ "dispose": function() {
			// capabilities never change — nothing to dispose
		} })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": function() {
			// nothing is watched — nothing to dispose
		} }),

		"stat": async function(resource): Promise<IStat> {
			const rel = toRel(resource.path);

			if (rel === undefined) {
				throw notFound();
			}

			if (rel === "") {
				return { "type": FileType.Directory, "ctime": 0, "mtime": 0, "size": 0 };
			}

			const meta = await fetchMeta(rel);

			if (meta === undefined) {
				throw notFound();
			}

			announce(resource, { "resource": resource, "type": FileChangeType.ADDED });

			return {
				"type": meta.type === "directory" ? FileType.Directory : FileType.File,
				"ctime": 0,
				"mtime": 0,
				"size": meta.size ?? 0
			};
		},

		"readFile": async function(resource): Promise<Uint8Array> {
			const rel = toRel(resource.path);

			if (rel === undefined || rel === "") {
				throw notFound();
			}

			const data = await fetchFile(rel);

			if (data === undefined) {
				throw notFound();
			}

			announce(resource, { "resource": resource, "type": FileChangeType.UPDATED });

			return data;
		},

		"readdir": async function(resource): Promise<[string, FileType][]> {
			const rel = toRel(resource.path);

			if (rel === undefined) {
				throw notFound();
			}

			if (rel === "") {
				return [];
			}

			const meta = await fetchMeta(rel);

			if (meta?.type !== "directory") {
				throw notFound();
			}

			return (meta.files ?? []).map((entry) => [
				entry.path.split("/").filter(Boolean).pop() ?? "",
				entry.type === "directory" ? FileType.Directory : FileType.File
			]);
		},

		"writeFile": () => Promise.reject(readOnly()),
		"mkdir": () => Promise.reject(readOnly()),
		"delete": () => Promise.reject(readOnly()),
		"rename": () => Promise.reject(readOnly())
	};
}
