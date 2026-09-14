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
import { createChangeEvent, fsTrace, notFound, readOnly, relUnder } from "./provider-base";

interface UnpkgMeta {
	"type": "file" | "directory";
	"size"?: number;
	"files"?: { "path": string; "type": "file" | "directory"; "size"?: number }[];
}

/** A spurious TypeScript-SOURCE probe: `.ts`/`.tsx`/`.mts`/`.cts` that is NOT a declaration (`.d.ts` …).
 *  Published packages never ship `.ts` source; tsserver probes `<pkg>/index.ts` before `.d.ts`, and the CDN
 *  answers those with content (a redirect to the real file), which tsserver then RESOLVES the import to
 *  ("is not a module") — shadowing the @types surface. Serving them notFound keeps the probe a failed lookup. */
function isTsSourceProbe(rel: string): boolean {
	return (/\.(?:tsx?|mts|cts)$/u).test(rel) && !(/\.d\.(?:ts|mts|cts)$/u).test(rel);
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
		fsTrace("nm.announce", key, { "changeType": change.type });

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

	// SYNCHRONOUS result caches. stat/readFile/readdir must answer the TS type-checker WITHOUT awaiting the
	// network: that checker reads through the @vscode/sync-api SAB bridge, which blocks a worker thread on the
	// reply, so an `await fetch(...)` here DEADLOCKS first-load analysis — workspace-fs throws notFound for a
	// not-yet-acquired type, the checker falls through to this overlay, and hangs forever ("Analyzing…"). Instead
	// serve resolved results synchronously and, on a miss, FAIL FAST (notFound) while fetching in the background;
	// the fetch caches the result and fires a change event (announce), so the checker re-reads and resolves. The
	// overlay was always "eventually-consistent" — this just stops it blocking the synchronous reader. (Async
	// go-to-definition uses the same methods; a first read may notFound and resolve on the follow-up change.)
	const metaResults = new Map<string, UnpkgMeta | undefined>();
	const fileResults = new Map<string, Uint8Array | undefined>();
	const metaInflight = new Set<string>();
	const fileInflight = new Set<string>();

	const ensureMeta = (rel: string, resource: Parameters<IFileSystemProviderWithFileReadWriteCapability["stat"]>[0]): void => {
		if (metaInflight.has(rel)) {
			return;
		}

		metaInflight.add(rel);
		void fetchMeta(rel).then((meta) => {
			metaResults.set(rel, meta);
			metaInflight.delete(rel);

			if (meta !== undefined) {
				announce(resource, { "resource": resource, "type": FileChangeType.ADDED });
			}
		});
	};

	const ensureFile = (rel: string, resource: Parameters<IFileSystemProviderWithFileReadWriteCapability["readFile"]>[0]): void => {
		if (fileInflight.has(rel)) {
			return;
		}

		fileInflight.add(rel);
		void fetchFile(rel).then((data) => {
			fileResults.set(rel, data);
			fileInflight.delete(rel);

			if (data !== undefined) {
				announce(resource, { "resource": resource, "type": FileChangeType.UPDATED });
			}
		});
	};

	// The set of paths (files AND dirs) a package ACTUALLY ships, from its ?meta listing. The CDN answers a request
	// for a path the package does NOT ship (e.g. react/index.ts, react/index.d.ts) with a redirect to its real
	// entry, so a blind fetch serves the wrong bytes and tsserver resolves the import to it ("is not a module"),
	// shadowing the @types surface. Gate every access on the listing so a probe for a non-shipped path stays a
	// FAILED lookup (→ @types). Same principle ATA uses — crawl the listing, never blindly probe.
	const pkgPaths = new Map<string, Set<string>>();
	const pkgPathsInflight = new Set<string>();

	const collectPaths = (node: UnpkgMeta, into: Set<string>): void => {
		for (const child of node.files ?? []) {
			into.add(child.path.replace(/^\/+/u, ""));

			if (child.type === "directory") {
				collectPaths(child as UnpkgMeta, into);
			}
		}
	};

	/** true = the package ships this sub-path, false = it doesn't (real miss), undefined = listing not fetched yet
	 *  (a background fetch is kicked off; announce re-triggers resolution once it lands). */
	const ships = (rel: string, resource: Parameters<IFileSystemProviderWithFileReadWriteCapability["stat"]>[0]): boolean | undefined => {
		const { pkg, sub } = splitPackage(rel);

		if (sub === "") {
			return true; // the package root dir itself
		}

		const set = pkgPaths.get(pkg);

		if (set !== undefined) {
			return set.has(sub);
		}

		if (!pkgPathsInflight.has(pkg) && served(rel)) {
			pkgPathsInflight.add(pkg);
			void fetchMeta(pkg).then((meta) => {
				const paths = new Set<string>();

				if (meta !== undefined) {
					collectPaths(meta, paths);
				}

				pkgPaths.set(pkg, paths);
				pkgPathsInflight.delete(pkg);
				fsTrace("nm.listing", pkg, { "count": paths.size, "hasSub": paths.has(sub) });

				// Re-trigger resolution ONLY when the probed path is genuinely shipped — that's a runtime lib whose
				// file just became servable. For a NOT-shipped probe (a spurious `<pkg>/index.d.ts` the CDN would
				// redirect), announcing "created" would make tsserver try to read a file that then answers notFound,
				// leaving it stuck mid-analysis; stay silent — its failed-lookup already fell through to @types.
				if (paths.has(sub)) {
					announce(resource, { "resource": resource, "type": FileChangeType.ADDED });
				}
			});
		}

		return undefined;
	};

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

		// All three reads are SYNCHRONOUS-SAFE: they answer from the resolved cache or fail fast (never awaiting a
		// fetch), so the sync-api checker can't deadlock on them. A miss kicks off the background fetch, which
		// caches + announces; the checker re-reads on that change and resolves.
		"stat": async function(resource): Promise<IStat> {
			const rel = toRel(resource.path);

			if (rel === undefined) {
				throw notFound();
			}

			if (rel === "") {
				return { "type": FileType.Directory, "ctime": 0, "mtime": 0, "size": 0 };
			}

			if (isTsSourceProbe(rel)) {
				fsTrace("nm.stat", rel, { "r": "tsprobe-notfound" });
				throw notFound();
			}

			const shipped = ships(rel, resource);

			if (shipped !== true) {
				fsTrace("nm.stat", rel, { "r": shipped === undefined ? "listing-pending" : "not-shipped" });

				throw notFound(); // package doesn't ship this path (or listing not known yet) — stay a failed lookup
			}

			if (!metaResults.has(rel)) {
				ensureMeta(rel, resource);

				fsTrace("nm.stat", rel, { "r": "failfast-miss" });

				throw notFound(); // not fetched yet — fail fast; the background fetch will announce and we re-stat
			}

			const meta = metaResults.get(rel);

			if (meta === undefined) {
				fsTrace("nm.stat", rel, { "r": "cached-miss" });

				throw notFound();
			}

			fsTrace("nm.stat", rel, { "r": "found", "type": meta.type });

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

			if (isTsSourceProbe(rel)) {
				fsTrace("nm.readFile", rel, { "r": "tsprobe-notfound" });

				throw notFound();
			}

			const shipped = ships(rel, resource);

			if (shipped !== true) {
				fsTrace("nm.readFile", rel, { "r": shipped === undefined ? "listing-pending" : "not-shipped" });

				throw notFound(); // package doesn't ship this path (or listing not known yet) — stay a failed lookup
			}

			if (!fileResults.has(rel)) {
				ensureFile(rel, resource);

				fsTrace("nm.readFile", rel, { "r": "failfast-miss" });

				throw notFound(); // not fetched yet — fail fast; the background fetch will announce and we re-read
			}

			fsTrace("nm.readFile", rel, { "r": fileResults.get(rel) === undefined ? "cached-miss" : "found" });

			const data = fileResults.get(rel);

			if (data === undefined) {
				throw notFound();
			}

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

			if (!metaResults.has(rel)) {
				ensureMeta(rel, resource);

				throw notFound();
			}

			const meta = metaResults.get(rel);

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
