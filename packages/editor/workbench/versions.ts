/**
 * Which version of each dependency the editor uses — one answer for every place that loads a package, so what the
 * baseline reads is what the preview runs. A package-lock.json's versions, where there is one; else each package.json
 * dependency, and theirs in turn, resolved to the newest version at least a week old that satisfies its range —
 * `silo install`'s rule (npm's `--before`), so `latest` means the latest a week old: a version published yesterday is
 * never what runs. When nothing that old satisfies a range, the newest that does, marked `young`.
 *
 * When each version was published is deps.dev's (`api.deps.dev`, which also says which one npm's `latest` tag is); a
 * version's own dependencies, npm's registry's manifest of it. Both allow cross-origin reads.
 *
 * Kept in `.silo/versions.json`, shared, when the repository has it there, else in `.silo/local/` (editor-api's `keptAt`) — the editor's lockfile, where there's no package-lock.json: a dependency keeps
 * its version until its range changes (only what's new or changed is resolved), so every collaborator loads what the
 * baseline was made from. The preview's dev server reads it from the workspace (its import map pins these versions),
 * and the baseline is synced to it (the capabilities extension's baseline.ts, which watches it). The node_modules
 * overlay and type acquisition read it as `pinned` (the build's own versions until the workspace's are resolved).
 *
 * A dependency the registry doesn't have is in it too: a `file:`/`link:` one by the folder it links (`link`), a tarball
 * URL by that URL (`tarball`), each at the version its package.json says. Those the editor installs itself, on every
 * sync (install.ts): `npm install` is this sync.
 */
import type * as vscodeApi from "vscode";
import { failureText } from "@brianjenkins94/editor-api/failures";
import { keptAt } from "@brianjenkins94/editor-api/git";
import { SILO_DIR, versionsPath } from "@brianjenkins94/util/silo/layout";
import semver from "semver";

/** The youngest a version may be, in days. */
export const MIN_AGE_DAYS = 7;


/** A dependency as resolved: its exact version, the range it was resolved from, and `young` when nothing old enough
 *  satisfied it. `tarball`: a lockfile's `resolved` URL, when it names one. `dependencies`: the names that version
 *  depends on (peers and optional ones too) — what the preview pins its dependencies by (esm.sh's `deps`). `platform`:
 *  a build for particular operating systems or CPUs only (its manifest's `os`/`cpu` — a native binary, such as each of
 *  TypeScript 7's `@typescript/typescript-<os>-<arch>`): npm installs only the one for the machine, and none runs in the
 *  browser, so nothing reads it (the baseline skips it). `link`: a `file:`/`link:` dependency's folder, relative to
 *  the workspace root — workspace code, not a package to fetch. */
export interface Resolved { "version": string; "range": string; "young"?: true; "tarball"?: string; "dependencies"?: string[]; "platform"?: true; "link"?: string }

/** A dependency npm's registry can't serve, so the CDN can't either: a linked folder, or a tarball from elsewhere. The
 *  editor installs these itself (install.ts). */
export const installsLocally = (each: Resolved): boolean => each.link !== undefined || (each.tarball !== undefined && !each.tarball.startsWith("https://registry.npmjs.org/"));

/** The version each package the CDN serves loads at, for what fetches them (the node_modules overlay, type
 *  acquisition): the build's own until the workspace's `.silo/versions.json` is read, then that. Kept up by each sync. */
export const pinned: Record<string, string> = {};

/** The packages the editor installs itself (installsLocally): nothing may fetch one of them from the CDN — a linked
 *  one's folder is the workspace's code. Kept up by each sync. */
export const installedLocally = new Set<string>();

/** `pinned` and `installedLocally`, from `packages` now. */
function repin(packages: Record<string, Resolved>): void {
	for (const name of Object.keys(pinned)) {
		delete pinned[name];
	}

	installedLocally.clear();

	for (const [name, each] of Object.entries(packages)) {
		if (installsLocally(each)) {
			installedLocally.add(name);
		} else {
			pinned[name] = each.version;
		}
	}
}

/** `file:../theme` in `dir` → `<dir>/../theme`, normalized, relative to the workspace root. */
export function linkedFolder(dir: string, range: string): string {
	const parts: string[] = [];

	for (const part of `${dir}/${range.replace(/^(?:file|link):/u, "")}`.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	return parts.join("/");
}

/** What `.silo/versions.json` holds. `format`: 2 since entries say `platform` (an older file's are read again once). */
export interface VersionsFile { "resolvedAt": string; "minAgeDays": number; "from": "package-lock.json" | "package.json"; "format"?: number; "packages": Record<string, Resolved> }

/** The file's format: 2 marks a platform build (Resolved's `platform`). */
const FORMAT = 2;

/** One version of a package, and when it was published (`latest`: npm's `latest` tag is it). */
export interface Published { "version": string; "at": string; "latest"?: boolean }

/** How many packages are resolved at once. */
const PARALLEL = 8;

/**
 * The version of a package `range` resolves to with nothing published after `cutoff` (ms): the highest that satisfies
 * it — for `latest` (or `*`, or nothing), the highest stable one no higher than npm's `latest` tag — among those old
 * enough; else among all, `young`. Undefined for a range it can't read (another dist-tag, a URL).
 */
export function choose(versions: readonly Published[], range: string, cutoff: number): { "version": string; "young": boolean } | undefined {
	const tagged = versions.find((each) => each.latest === true)?.version;
	const pick = (pool: readonly Published[]): string | undefined => {
		const candidates = pool.map((each) => each.version).filter((version) => semver.valid(version) !== null);

		if (range === "" || range === "*" || range === "latest") {
			const stable = candidates.filter((version) => semver.prerelease(version) === null && (tagged === undefined || semver.lte(version, tagged)));

			return stable.toSorted(semver.rcompare)[0] ?? undefined;
		}

		return semver.validRange(range) === null ? undefined : semver.maxSatisfying(candidates, range) ?? undefined;
	};
	const old = pick(versions.filter((each) => Date.parse(each.at) <= cutoff));

	if (old !== undefined) {
		return { "version": old, "young": false };
	}

	const any = pick(versions);

	return any === undefined ? undefined : { "version": any, "young": true };
}

const publishedOf = new Map<string, Promise<Published[]>>();

/** Every version of `name` deps.dev knows, with when it was published (asked once a session). */
function published(name: string): Promise<Published[]> {
	if (!publishedOf.has(name)) {
		publishedOf.set(name, fetch(`https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(name)}`).then(async (response) => {
			if (!response.ok) {
				throw new Error(`deps.dev: ${response.status} for ${name}`);
			}

			const { versions } = await response.json() as { "versions": { "versionKey": { "version": string }; "publishedAt"?: string; "isDefault"?: boolean }[] };

			return versions.filter((each) => each.publishedAt !== undefined).map((each) => ({ "version": each.versionKey.version, "at": each.publishedAt!, ...each.isDefault === true ? { "latest": true } : {} }));
		}).catch((error: unknown) => {
			publishedOf.delete(name);

			throw error;
		}));
	}

	return publishedOf.get(name)!;
}

/** Whether a manifest (a registry's, a lockfile entry) is a build for particular operating systems or CPUs only. */
const isPlatform = (manifest: { "os"?: unknown; "cpu"?: unknown }): boolean => (Array.isArray(manifest.os) && manifest.os.length > 0) || (Array.isArray(manifest.cpu) && manifest.cpu.length > 0);

/** `name`@`version`'s own dependencies — its peers and optional ones too, as npm installs them — by name: their ranges,
 *  from its manifest on npm's registry; and whether it's a platform build (isPlatform). */
async function manifestOf(name: string, version: string): Promise<{ "dependencies": Record<string, string>; "platform": boolean }> {
	const response = await fetch(`https://registry.npmjs.org/${name}/${version}`);

	if (!response.ok) {
		throw new Error(`registry: ${response.status} for ${name}@${version}`);
	}

	const manifest = await response.json() as Partial<Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>> & { "os"?: unknown; "cpu"?: unknown };

	return { "dependencies": { ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies }, "platform": isPlatform(manifest) };
}

/** A dependency range the registry can resolve (not a file:, link:, git or URL dependency, nor an npm: alias). */
export const resolvable = (range: string): boolean => !/^(?:file|link|workspace|git|git\+[a-z]+|https?|npm):|\//u.test(range);

/**
 * `roots` (a project's dependencies, name → range) and theirs in turn, each resolved with nothing younger than
 * `minAgeDays` (choose) — each name once, the first found (a root before what it depends on). `known`: what's resolved
 * already, kept as it is (a lockfile's way: a root whose range changed is left out of it by the caller). A package that
 * can't be resolved is left out.
 */
export async function resolveVersions(roots: Record<string, string>, { minAgeDays = MIN_AGE_DAYS, now = Date.now(), known = {} }: { "minAgeDays"?: number; "now"?: number; "known"?: Record<string, Resolved> } = {}): Promise<Record<string, Resolved>> {
	const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
	const resolved: Record<string, Resolved> = { ...known };
	const queue: [string, string][] = Object.entries(roots);
	// (one resolved before what it depends on was kept: what it depends on read now — its version kept as it is)
	const unread = Object.entries(known).filter(([, each]) => each.dependencies === undefined);

	for (let at = 0; at < unread.length; at += PARALLEL) {
		await Promise.all(unread.slice(at, at + PARALLEL).map(async ([name, each]) => {
			const manifest = await manifestOf(name, each.version).catch(() => undefined);

			if (manifest !== undefined) {
				resolved[name] = { ...each, "dependencies": Object.keys(manifest.dependencies).toSorted(), ...manifest.platform ? { "platform": true as const } : {} };
				queue.push(...Object.entries<string>(manifest.dependencies));
			}
		}));
	}

	while (queue.length > 0) {
		const batch = queue.splice(0, PARALLEL).filter(([name, range], index, all) => !(name in resolved) && resolvable(range) && all.findIndex(([other]) => other === name) === index);

		await Promise.all(batch.map(async ([name, range]) => {
			try {
				const chosen = choose(await published(name), range, cutoff);

				if (chosen !== undefined && !(name in resolved)) {
					const manifest = await manifestOf(name, chosen.version);

					resolved[name] ??= { "version": chosen.version, "range": range, ...chosen.young ? { "young": true as const } : {}, "dependencies": Object.keys(manifest.dependencies).toSorted(), ...manifest.platform ? { "platform": true as const } : {} };
					queue.push(...Object.entries<string>(manifest.dependencies));
				}
			} catch {
				// (left out: what can't be resolved now is resolved the next time)
			}
		}));
	}

	return Object.fromEntries(Object.entries(resolved).toSorted(([one], [other]) => one.localeCompare(other)));
}

/** The packages a lockfile installs (npm's v2/v3 `packages`), each name once — the first, root before nested; a linked
 *  one by its folder (relative to the workspace root: the lockfile is in `dir`), its version still to be read. */
export function lockedVersions(lock: { "packages"?: Record<string, { "version"?: string; "resolved"?: string; "link"?: boolean; "os"?: unknown; "cpu"?: unknown } & Partial<Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>>> }, dir = ""): Record<string, Resolved> {
	const locked: Record<string, Resolved> = {};

	for (const [path, entry] of Object.entries(lock.packages ?? {}).toSorted(([one], [other]) => one.split("node_modules/").length - other.split("node_modules/").length)) {
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

		if (path.includes("node_modules/") && entry.link === true && entry.resolved !== undefined && !(name in locked)) {
			locked[name] = { "version": entry.version ?? "0.0.0", "range": `file:${entry.resolved}`, "link": linkedFolder(dir, entry.resolved) };
		} else if (path.includes("node_modules/") && entry.version !== undefined && entry.link !== true && !(name in locked)) {
			const dependencies = Object.keys({ ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.dependencies }).toSorted();

			locked[name] = { "version": entry.version, "range": entry.version, ...entry.resolved?.startsWith("https://") === true ? { "tarball": entry.resolved } : {}, "dependencies": dependencies, ...isPlatform(entry) ? { "platform": true as const } : {} };
		}
	}

	return locked;
}

/** What the manifests (each in its `dir`, root first) depend on: from the registry by range (`roots`), else (`local`) a
 *  linked folder or a tarball URL, each the first manifest's to name it — but a folder before a tarball: in a monorepo
 *  whose packages depend on each other's published copies too, the folder is the package's source, which is what gets
 *  edited. */
function dependenciesOf(manifests: { "dir": string; "manifest": unknown }[]): { "roots": Record<string, string>; "local": Record<string, Resolved> } {
	const roots: Record<string, string> = {};
	const local: Record<string, Resolved> = {};

	for (const { dir, manifest } of manifests) {
		const { dependencies, devDependencies } = (manifest ?? {}) as Partial<Record<"dependencies" | "devDependencies", Record<string, string>>>;

		for (const [name, range] of Object.entries({ ...devDependencies, ...dependencies })) {
			if (/^(?:file|link):/u.test(range)) {
				local[name] = local[name]?.link === undefined ? { "version": "0.0.0", "range": range, "link": linkedFolder(dir, range) } : local[name];
			} else if (/^https?:\/\//u.test(range)) {
				local[name] ??= { "version": "0.0.0", "range": range, "tarball": range };
			} else {
				roots[name] ??= range;
			}
		}
	}

	return { "roots": roots, "local": local };
}

/** Of `dependencies`, those the editor installs itself, installed — linked, or fetched and unpacked, as npm would — each
 *  at its package.json's version (one `known` already, its range unchanged, as it was). */
async function installOwn(vscode: typeof vscodeApi, root: string, dependencies: Record<string, Resolved>, known: Record<string, Resolved>): ReturnType<typeof import("./install").install> {
	const ours = Object.fromEntries(Object.entries(dependencies).filter(([, each]) => installsLocally(each)).map(([name, each]): [string, Resolved] => [name, known[name]?.range === each.range ? known[name] : each]));
	const { install } = await import("./install");

	for (const name of Object.keys(ours)) {
		installedLocally.add(name);
	}

	return install(vscode, root, ours);
}

/** One resolution at a time; one asked for while one runs is run after it. */
let syncing: Promise<VersionsFile | undefined> = Promise.resolve(undefined);
let queued = false;

/**
 * `.silo/versions.json` (at `root`) brought up to the project's dependencies now — its package-lock.json's, else
 * its package.jsons', resolved — and what it holds. Written only when what it says changes.
 */
export function syncVersions(vscode: typeof vscodeApi, root = "/workspace"): Promise<VersionsFile | undefined> {
	if (queued) {
		return syncing;
	}

	queued = true;
	syncing = syncing.then(async () => {
		queued = false;

		const read = async (file: vscodeApi.Uri): Promise<unknown> => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as unknown;
		const lock = await read(vscode.Uri.file(`${root}/package-lock.json`)).catch(() => undefined) as Parameters<typeof lockedVersions>[0] | undefined;
		const files = (await vscode.workspace.findFiles("**/package.json", `{**/node_modules/**,**/${SILO_DIR}/**}`)).toSorted((one, other) => one.path.length - other.path.length);
		const { roots, local } = dependenciesOf(await Promise.all(files.map(async (file) => ({ "dir": file.path.slice(root.length + 1, file.path.lastIndexOf("/")), "manifest": await read(file).catch(() => undefined) }))));

		const at = await keptAt(versionsPath(), async (path) => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`${root}/${path}`))).then(() => true, () => false));
		const uri = vscode.Uri.file(`${root}/${at}`);
		const before = await read(uri).catch(() => undefined) as VersionsFile | undefined;
		// (what was resolved stays, but a root whose range changed: resolved again, with what it now depends on — and a file
		// from before `platform`: each entry's manifest read again once, its version kept)
		const kept = Object.entries(before?.from === "package.json" ? before.packages : {}).filter(([name, each]) => (roots[name] ?? local[name]?.range) === undefined || (roots[name] ?? local[name]?.range) === each.range);
		const known = Object.fromEntries(before?.format === FORMAT ? kept : kept.map(([name, { "dependencies": _, ...each }]) => [name, each]));
		const locked = lock?.packages === undefined ? undefined : lockedVersions(lock);
		// What the editor installs itself first: a link costs nothing, and TypeScript is waiting on it; the registry's tree
		// can take a while to resolve.
		const { installed, wants, changed } = await installOwn(vscode, root, { ...locked, ...local }, known);
		const from = lock?.packages === undefined ? "package.json" : "package-lock.json";
		const file = (packages: Record<string, Resolved>): VersionsFile => ({ "resolvedAt": new Date().toISOString(), "minAgeDays": MIN_AGE_DAYS, "from": from, "format": FORMAT, "packages": packages });
		const linked = { ...before?.packages, ...installed };

		// Said at once — the TypeScript server reads the links from this file (the capabilities tsserver plugin) — before
		// the registry's tree is resolved and the file written whole.
		if (JSON.stringify(linked) !== JSON.stringify(before?.packages)) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(file(linked), undefined, 2) + "\n"));
		}

		if (changed) {
			// (TypeScript may have looked for these before they were there: it resolves again)
			void vscode.commands.executeCommand("typescript.reloadProjects");
		}

		// Then the registry's: the roots, and what an unpacked tarball depends on, in turn.
		const theirs = Object.fromEntries(Object.entries(wants).filter(([name]) => !(name in (locked ?? roots))));
		const packages = locked === undefined
			? await resolveVersions({ ...theirs, ...roots }, { "known": { ...known, ...installed } })
			: await resolveVersions(theirs, { "known": { ...locked, ...installed } });

		repin(packages);

		const now = file(packages);

		if (before !== undefined && before.format === FORMAT && JSON.stringify(before.packages) === JSON.stringify(packages)) {
			return before;
		}

		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(now, undefined, 2) + "\n"));

		const young = Object.entries(packages).filter(([, each]) => each.young === true).map(([name, each]) => `${name}@${each.version}`);

		console.info(`[versions] ${Object.keys(packages).length} packages, from ${now.from}${now.from === "package.json" ? `, nothing younger than ${MIN_AGE_DAYS} days` : ""}`);

		if (young.length > 0) {
			console.warn(`[versions] nothing ${MIN_AGE_DAYS} days old satisfies these ranges, so their newest is used: ${young.join(", ")}`);
		}

		return now;
	}).catch((error: unknown) => {
		console.error("[versions] couldn't be resolved:", failureText(error));

		return undefined;
	});

	return syncing;
}

/** Keep `.silo/versions.json` up to the project's dependencies: resolved as the project opens, and again as a
 *  package.json or package-lock.json changes — so a preview or run started before then pins them, and the baseline (the
 *  capabilities extension's, which watches this file) follows them. */
export function watchVersions(vscode: typeof vscodeApi): vscodeApi.Disposable {
	const watcher = vscode.workspace.createFileSystemWatcher("**/{package.json,package-lock.json}");
	const changed = (uri: vscodeApi.Uri): void => {
		if (!uri.path.includes("/node_modules/")) {
			void syncVersions(vscode);
		}
	};

	const listeners = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];

	void syncVersions(vscode);

	return { "dispose": () => {
		for (const listener of [...listeners, watcher]) {
			listener.dispose();
		}
	} };
}
