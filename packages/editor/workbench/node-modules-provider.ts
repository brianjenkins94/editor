import type { IFileChange, IFileSystemProviderWithFileReadWriteCapability, IStat } from "@brianjenkins94/monaco-vscode-api/main";
import {
	FileChangeType,
	FileSystemProviderCapabilities,
	FileType
} from "@brianjenkins94/monaco-vscode-api/main";
import { logger } from "@brianjenkins94/util/logger";
import { timeCall } from "../shared/fs-boundaries";
import { vscodeCaller } from "../shared/fs-caller";
import { createChangeEvent, notFound, readOnly, relUnder } from "./provider-base";
import { normalized, packagesNamedBy, relativeImports, splitPackage } from "./node-modules-prefetch";
import { tarball } from "./tarballs";
import { aliases } from "./versions";

interface UnpkgMeta {
	"type"?: string;
	"prefix"?: string;
	"size"?: number;
	"files"?: { "path": string; "type"?: string; "size"?: number }[];
}

function childEntries(meta: UnpkgMeta): [string, FileType][] {
	if (meta.type === "directory") {
		return (meta.files ?? []).map((entry) => [
			entry.path.split("/").filter(Boolean).pop() ?? "",
			entry.type === "directory" ? FileType.Directory : FileType.File
		]);
	}

	const children = new Map<string, FileType>();

	for (const entry of meta.files ?? []) {
		const [name, ...deeper] = entry.path.slice((meta.prefix ?? "/").length).split("/").filter(Boolean);

		if (name !== undefined) {
			children.set(name, deeper.length > 0 ? FileType.Directory : FileType.File);
		}
	}

	return [...children];
}

function isTsSourceProbe(rel: string): boolean {
	return (/\.(?:tsx?|mts|cts)$/u).test(rel) && !(/\.d\.(?:ts|mts|cts)$/u).test(rel);
}

const PREFETCH_DEPTH = 3;

const IMPORT_TRIES = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", "/index.js"];

const log = logger({ "source": "workbench" });

export type NodeModulesProvider = IFileSystemProviderWithFileReadWriteCapability & { "prefetchFor": (files: string[], read: (path: string) => Promise<string | undefined>) => Promise<string[]> };

export function createNodeModulesProvider(workspaceFolder: string, versions: Record<string, string>): NodeModulesProvider {
	const prefix = workspaceFolder.replace(/\/$/u, "") + "/node_modules";
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

	const served = (rel: string): boolean => versions[splitPackage(rel).pkg] !== undefined;

	const cache = new Map<string, Promise<unknown>>();
	const memoFetch = <T>(rel: string, query: string, parse: (res: Response) => Promise<T>): Promise<T | undefined> => {
		if (!served(rel)) {
			return Promise.resolve(undefined);
		}

		const { pkg } = splitPackage(rel);
		const version = versions[pkg];
		const real = aliases[pkg] === undefined ? "" : `&p=${encodeURIComponent(aliases[pkg])}`;
		const search = (query === "?meta" ? `?meta&v=${version}` : `?v=${version}`) + real;
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

	const metaResults = new Map<string, UnpkgMeta | undefined>();
	const fileResults = new Map<string, Uint8Array | undefined>();
	const metaInflight = new Set<string>();
	const fileInflight = new Set<string>();
	const whole = new Set<string>();
	const folders = new Map<string, Map<string, FileType>>();
	const prefetching = new Map<string, Promise<void>>();
	const absent = (rel: string): boolean => whole.has(splitPackage(rel).pkg) && !fileResults.has(rel) && !folders.has(rel);

	const prefetch = (name: string): Promise<void> => {
		const version = versions[name];

		if (version === undefined) {
			return Promise.resolve();
		}

		if (!prefetching.has(name)) {
			prefetching.set(name, (async () => {
				const [{ unpack }, bytes] = await Promise.all([import("@brianjenkins94/almostnode/packages"), tarball(aliases[name] ?? name, version)]);

				for (const [path, data] of unpack(bytes)) {
					const rel = `${name}/${path}`;
					let child = rel;
					let type = FileType.File;

					fileResults.set(rel, data);

					while (child.length > name.length) {
						const at = child.slice(0, child.lastIndexOf("/"));
						const entries = folders.get(at) ?? new Map<string, FileType>();

						entries.set(child.slice(at.length + 1), type);
						folders.set(at, entries);
						child = at;
						type = FileType.Directory;
					}
				}

				whole.add(name);
			})().catch((error: unknown) => {
				prefetching.delete(name); // (asked again next time: the CDN goes on answering it a file at a time meanwhile)

				throw error;
			}));
		}

		return prefetching.get(name)!;
	};

	const prefetchFor = (files: string[], read: (path: string) => Promise<string | undefined>): Promise<string[]> => log.span("editor.workbench.node-modules-provider.prefetch", { "count": files.length }, async (span) => {
		const seen = new Set<string>();
		const named = new Set<string>();
		let level = files.map((file) => normalized(file));

		for (let depth = 0; depth < PREFETCH_DEPTH && level.length > 0; depth += 1) {
			const next: string[] = [];

			for (const file of level.filter((each) => !seen.has(each) && !each.includes("/node_modules/"))) {
				seen.add(file);

				const text = await read(file);

				if (text === undefined) {
					continue;
				}

				for (const name of packagesNamedBy(text, versions)) {
					named.add(name);
				}

				const folder = file.slice(0, file.lastIndexOf("/"));

				for (const specifier of relativeImports(text)) {
					const target = normalized(`${folder}/${specifier}`);
					const tries = await Promise.all(IMPORT_TRIES.map(async (suffix) => (await read(target + suffix) === undefined ? undefined : target + suffix)));
					const found = tries.find((each) => each !== undefined);

					if (found !== undefined) {
						next.push(found);
					}
				}
			}

			level = next;
		}

		const results = await Promise.allSettled([...named].map(async (name) => prefetch(name)));
		const failed = [...named].filter((_, index) => results[index].status === "rejected");

		span.end({ "files": seen.size, "packages": named.size, "failed": failed.length });

		return [...named].filter((name) => !failed.includes(name));
	});

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

	const provider: IFileSystemProviderWithFileReadWriteCapability = {
		"capabilities":
			FileSystemProviderCapabilities.FileReadWrite
			| FileSystemProviderCapabilities.PathCaseSensitive
			| FileSystemProviderCapabilities.Readonly,
		"onDidChangeCapabilities": (() => ({ "dispose": function() {
		} })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": function() {
		} }),

		"stat": function(resource): Promise<IStat> {
			const rel = toRel(resource.path);

			if (rel === undefined) {
				return Promise.reject(notFound());
			}

			if (rel === "") {
				return Promise.resolve({ "type": FileType.Directory, "ctime": 0, "mtime": 0, "size": 0 });
			}

			if (isTsSourceProbe(rel)) {
				return Promise.reject(notFound());
			}

			if (folders.has(rel)) {
				return Promise.resolve({ "type": FileType.Directory, "ctime": 0, "mtime": 0, "size": 0 });
			}

			if (absent(rel)) {
				return Promise.reject(notFound());
			}

			if (!fileResults.has(rel)) {
				ensureFile(rel, resource);

				return Promise.reject(notFound()); // not fetched yet — fail fast; the background fetch caches + announces, then we re-stat
			}

			const statData = fileResults.get(rel);

			if (statData === undefined) {
				return Promise.reject(notFound()); // 404 at the CDN — the file genuinely doesn't exist
			}

			return Promise.resolve({ "type": FileType.File, "ctime": 0, "mtime": 0, "size": statData.length });
		},

		"readFile": function(resource): Promise<Uint8Array> {
			const rel = toRel(resource.path);

			if (rel === undefined || rel === "") {
				return Promise.reject(notFound());
			}

			if (isTsSourceProbe(rel) || absent(rel)) {
				return Promise.reject(notFound());
			}

			if (!fileResults.has(rel)) {
				ensureFile(rel, resource);

				return Promise.reject(notFound()); // not fetched yet — fail fast; the background fetch will announce and we re-read
			}

			const data = fileResults.get(rel);

			if (data === undefined) {
				return Promise.reject(notFound());
			}

			return Promise.resolve(data);
		},

		"readdir": function(resource): Promise<[string, FileType][]> {
			const rel = toRel(resource.path);

			if (rel === undefined) {
				return Promise.reject(notFound());
			}

			if (rel === "") {
				return Promise.resolve([]);
			}

			const listed = folders.get(rel);

			if (listed !== undefined) {
				return Promise.resolve([...listed]);
			}

			if (absent(rel)) {
				return Promise.reject(notFound());
			}

			if (!metaResults.has(rel)) {
				ensureMeta(rel, resource);

				return Promise.reject(notFound());
			}

			const meta = metaResults.get(rel);
			const children = meta === undefined ? [] : childEntries(meta);

			if (children.length === 0) {
				return Promise.reject(notFound());
			}

			return Promise.resolve(children);
		},

		"writeFile": () => Promise.reject(readOnly()),
		"mkdir": () => Promise.reject(readOnly()),
		"delete": () => Promise.reject(readOnly()),
		"rename": () => Promise.reject(readOnly())
	};

	for (const method of ["stat", "readFile", "readdir"] as const) {
		const original = provider[method].bind(provider) as (resource: { "path": string }) => unknown;

		(provider as unknown as Record<string, unknown>)[method] = (resource: { "path": string }): unknown => timeCall("node_modules", method, vscodeCaller(), resource.path, () => original(resource));
	}

	return Object.assign(provider, { "prefetchFor": prefetchFor });
}
