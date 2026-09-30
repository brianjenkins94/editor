/**
 * Bare-import resolution for the dev server, with no install step and no import map:
 *
 * - A dependency with a registry version (`"react": "^19"`) resolves to esm.sh, as the import map had it.
 * - A dependency given as a URL to a tarball (`"@x/hub": "https://…/hub@latest.tgz"`) is fetched once, unpacked in
 *   memory, and served from the dev server itself, at `/@pkg/<name>/<file>` — its `exports` map picks the file.
 *
 * Served modules get their bare imports REWRITTEN to those URLs (`rewriteImports`), rather than left to an import
 * map: a document's import map doesn't apply inside a worker, so a module worker importing a package would fail.
 * A package's own bare imports resolve against its manifest (a peer against the app's declaration of it).
 *
 * Self-contained (no dev-server imports), so it can be tested on its own.
 */
import type ts from "typescript";
import pako from "pako";
import { exports as resolveExports } from "resolve.exports";

/** Where a served package file lives: `/@pkg/<name>/<file>`. */
export const PACKAGE_PREFIX = "/@pkg/";

export interface Manifest {
	"name"?: string;
	"main"?: string;
	"module"?: string;
	"exports"?: unknown;
	"dependencies"?: Record<string, string>;
	"devDependencies"?: Record<string, string>;
	"peerDependencies"?: Record<string, string>;
	"optionalDependencies"?: Record<string, string>;
}

interface Tarball {
	"url": string;
	"manifest": Manifest;
	"files": Map<string, Uint8Array>;
}

/** `@scope/name/sub/path` → { name: "@scope/name", subpath: "./sub/path" }; `name` → { name, subpath: "." }. */
export function splitSpecifier(specifier: string): { "name": string; "subpath": string } {
	const parts = specifier.split("/");
	const size = specifier.startsWith("@") ? 2 : 1;
	const rest = parts.slice(size).join("/");

	return { "name": parts.slice(0, size).join("/"), "subpath": rest === "" ? "." : "./" + rest };
}

/** A bare specifier: not relative, not absolute, not a URL (`https:`, `data:`, `node:` …). */
export function isBare(specifier: string): boolean {
	return !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-z][\d+.a-z-]*:/iu.test(specifier);
}

function isTarballSpec(spec: string): boolean {
	return /^https?:\/\//iu.test(spec);
}

/** A version esm.sh can serve (a semver range or tag) — not a URL, `file:`, `workspace:`, git … */
export function isRegistrySpec(spec: string): boolean {
	return !/^[a-z][\d+.a-z-]*:/iu.test(spec) && !spec.includes("/");
}

/** The entries of a ustar archive (gunzipped): regular files, their paths with the leading `package/` dropped. */
export function untar(archive: Uint8Array): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	const text = (from: number, length: number): string => {
		const bytes = archive.subarray(from, from + length);
		const end = bytes.indexOf(0);

		return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
	};
	let offset = 0;
	let longName: string | undefined;

	while (offset + 512 <= archive.length) {
		const name = text(offset, 100);

		if (name === "") {
			break;
		}

		const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(archive[offset + 156]);
		const prefix = text(offset + 257, 6) === "ustar" ? text(offset + 345, 155) : "";
		const body = archive.subarray(offset + 512, offset + 512 + size);

		if (type === "x") {
			// A pax header: a long path for the next entry.
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(new TextDecoder().decode(body))?.[1];
		} else if (type === "0" || type === "\0") {
			const path = longName ?? (prefix === "" ? name : prefix + "/" + name);

			files.set(path.replace(/^[^/]+\//u, ""), body);
			longName = undefined;
		}

		offset += 512 + Math.ceil(size / 512) * 512;
	}

	return files;
}

/** The file a package subpath resolves to, by its `exports` (browser/import conditions), else `module`/`main`. */
export function resolveEntry(manifest: Manifest, subpath: string): string | undefined {
	if (manifest.exports !== undefined) {
		try {
			const [target] = resolveExports(manifest as Parameters<typeof resolveExports>[0], subpath, { "browser": true, "conditions": ["import", "module"] }) ?? [];

			return target?.replace(/^\.\//u, "");
		} catch {
			return undefined;
		}
	}

	if (subpath === ".") {
		return (manifest.module ?? manifest.main ?? "index.js").replace(/^\.\//u, "");
	}

	return subpath.slice(2);
}

/** `from` → `to` as a relative URL (both absolute paths within the server). */
export function relativeUrl(from: string, to: string): string {
	const fromParts = from.split("/").slice(0, -1);
	const toParts = to.split("/");
	let common = 0;

	while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
		common += 1;
	}

	const up = fromParts.length - common;
	const path = [...Array.from({ "length": up }, () => ".."), ...toParts.slice(common)].join("/");

	return up === 0 ? "./" + path : path;
}

export interface PackageResolverOptions {
	/** The app's package.json (read fresh each time it's needed, so an edit takes effect). */
	"manifest": () => Manifest | undefined;
	"fetch"?: typeof fetch;
	/** esm.sh URL for a registry dependency (default: `https://esm.sh/<name>@<version><subpath>`). */
	"registryUrl"?: (name: string, version: string, subpath: string) => string;
}

export class PackageResolver {
	private readonly tarballs = new Map<string, Promise<Tarball>>();
	/** Package name → the tarball URL it's served from (the first one asked for). */
	private readonly served = new Map<string, string>();

	private readonly options: PackageResolverOptions;

	public constructor(options: PackageResolverOptions) {
		this.options = options;
	}

	/** The app's declared dependencies (`dependencies` and `devDependencies`, as a bundler would resolve them). */
	public appDependencies(): Record<string, string> {
		const manifest = this.options.manifest();

		return { ...manifest?.devDependencies, ...manifest?.dependencies };
	}

	/** Where a bare `specifier` imported by `importer` (a server path: an app module, or a `/@pkg/…` file) lives: an
	 *  esm.sh URL, a `/@pkg/…` server path, or undefined when nothing declares it (it's left as is). */
	public async resolve(specifier: string, importer: string): Promise<string | undefined> {
		const { name, subpath } = splitSpecifier(specifier);
		const spec = await this.specFor(name, importer);

		if (spec === undefined) {
			return undefined;
		}

		if (isTarballSpec(spec)) {
			const tarball = await this.tarball(name, spec);
			const file = resolveEntry(tarball.manifest, subpath);

			return file === undefined ? undefined : PACKAGE_PREFIX + name + "/" + file;
		}

		if (isRegistrySpec(spec)) {
			const sub = subpath === "." ? "" : subpath.slice(1);

			return this.options.registryUrl?.(name, spec, sub) ?? `https://esm.sh/${name}@${spec}${sub}`;
		}

		return undefined;
	}

	/** A served package file (`/@pkg/<name>/<file>`), or undefined. */
	public async file(path: string): Promise<Uint8Array | undefined> {
		const located = this.locate(path);

		if (located === undefined) {
			return undefined;
		}

		const url = this.served.get(located.name);

		return url === undefined ? undefined : (await this.tarball(located.name, url)).files.get(located.file);
	}

	/** Rewrite `code`'s bare imports (static, dynamic, re-exports) to where they resolve, relative to `importer` — so
	 *  they resolve anywhere, a worker included. Unresolvable ones are left alone. */
	public async rewriteImports(code: string, importer: string, typescript: typeof ts): Promise<string> {
		const found = typescript.preProcessFile(code, true, true).importedFiles.filter((file) => isBare(file.fileName));
		let result = code;

		// Back to front, so earlier positions stay valid.
		for (const file of found.toSorted((left, right) => right.pos - left.pos)) {
			// `pos` is at the specifier's opening quote.
			const start = file.pos + 1;

			if (result.slice(start, start + file.fileName.length) !== file.fileName) {
				continue;
			}

			const target = await this.resolve(file.fileName, importer);

			if (target !== undefined) {
				const replacement = target.startsWith("/") ? relativeUrl(importer, target) : target;

				result = result.slice(0, start) + replacement + result.slice(start + file.fileName.length);
			}
		}

		return result;
	}

	/** `/@pkg/@scope/name/dist/x.js` → { name: "@scope/name", file: "dist/x.js" }. */
	private locate(path: string): { "name": string; "file": string } | undefined {
		if (!path.startsWith(PACKAGE_PREFIX)) {
			return undefined;
		}

		const { name, subpath } = splitSpecifier(path.slice(PACKAGE_PREFIX.length));

		return subpath === "." ? undefined : { "name": name, "file": subpath.slice(2) };
	}

	/** How `name` is declared for `importer`: by the importing package (a peer defers to the app), else by the app. */
	private async specFor(name: string, importer: string): Promise<string | undefined> {
		const app = this.appDependencies();
		const located = this.locate(importer);

		if (located !== undefined) {
			const url = this.served.get(located.name);
			const manifest = url === undefined ? undefined : (await this.tarball(located.name, url)).manifest;
			const own = manifest?.dependencies?.[name] ?? manifest?.optionalDependencies?.[name];

			if (own !== undefined && app[name] === undefined) {
				return own;
			}

			if (manifest?.peerDependencies?.[name] !== undefined || own !== undefined) {
				return app[name] ?? own;
			}
		}

		return app[name];
	}

	private tarball(name: string, url: string): Promise<Tarball> {
		const chosen = this.served.get(name) ?? url;

		this.served.set(name, chosen);

		let loading = this.tarballs.get(chosen);

		if (loading === undefined) {
			loading = (async () => {
				const response = await (this.options.fetch ?? fetch)(chosen);

				if (!response.ok) {
					throw new Error(`${name}: ${chosen} answered ${response.status}`);
				}

				const files = untar(pako.ungzip(new Uint8Array(await response.arrayBuffer())));
				const manifestBytes = files.get("package.json");

				return { "url": chosen, "manifest": manifestBytes === undefined ? {} : JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest, "files": files };
			})();
			// A failed fetch isn't remembered: the next request tries again.
			loading.catch(() => { this.tarballs.delete(chosen); });
			this.tarballs.set(chosen, loading);
		}

		return loading;
	}
}
