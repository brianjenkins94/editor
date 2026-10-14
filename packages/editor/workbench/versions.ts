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
 * Kept in `.silo/versions.json`, shared — the editor's lockfile, where there's no package-lock.json: a dependency keeps
 * its version until its range changes (only what's new or changed is resolved), so every collaborator loads what the
 * baseline was made from. The preview's dev server reads it from the workspace (its import map pins these versions),
 * and the baseline is synced to it (baseline.ts).
 */
import type * as vscodeApi from "vscode";
import { SILO_DIR, versionsPath } from "@brianjenkins94/util/silo/layout";
import semver from "semver";

/** The youngest a version may be, in days. */
export const MIN_AGE_DAYS = 7;


/** A dependency as resolved: its exact version, the range it was resolved from, and `young` when nothing old enough
 *  satisfied it. `tarball`: a lockfile's `resolved` URL, when it names one. `dependencies`: the names that version
 *  depends on (peers and optional ones too) — what the preview pins its dependencies by (esm.sh's `deps`). */
export interface Resolved { "version": string; "range": string; "young"?: true; "tarball"?: string; "dependencies"?: string[] }

/** What `.silo/versions.json` holds. */
export interface VersionsFile { "resolvedAt": string; "minAgeDays": number; "from": "package-lock.json" | "package.json"; "packages": Record<string, Resolved> }

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

/** `name`@`version`'s own dependencies — its peers and optional ones too, as npm installs them — by name: their ranges,
 *  from its manifest on npm's registry. */
async function dependenciesOf(name: string, version: string): Promise<Record<string, string>> {
	const response = await fetch(`https://registry.npmjs.org/${name}/${version}`);

	if (!response.ok) {
		throw new Error(`registry: ${response.status} for ${name}@${version}`);
	}

	const manifest = await response.json() as Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string> | undefined>;

	return { ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies };
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
			const dependencies = await dependenciesOf(name, each.version).catch(() => undefined);

			if (dependencies !== undefined) {
				resolved[name] = { ...each, "dependencies": Object.keys(dependencies).toSorted() };
				queue.push(...Object.entries<string>(dependencies));
			}
		}));
	}

	while (queue.length > 0) {
		const batch = queue.splice(0, PARALLEL).filter(([name, range], index, all) => !(name in resolved) && resolvable(range) && all.findIndex(([other]) => other === name) === index);

		await Promise.all(batch.map(async ([name, range]) => {
			try {
				const chosen = choose(await published(name), range, cutoff);

				if (chosen !== undefined && !(name in resolved)) {
					const dependencies = await dependenciesOf(name, chosen.version);

					resolved[name] ??= { "version": chosen.version, "range": range, ...chosen.young ? { "young": true as const } : {}, "dependencies": Object.keys(dependencies).toSorted() };
					queue.push(...Object.entries<string>(dependencies));
				}
			} catch {
				// (left out: what can't be resolved now is resolved the next time)
			}
		}));
	}

	return Object.fromEntries(Object.entries(resolved).toSorted(([one], [other]) => one.localeCompare(other)));
}

/** The packages a lockfile installs (npm's v2/v3 `packages`), each name once — the first, root before nested. */
export function lockedVersions(lock: { "packages"?: Record<string, { "version"?: string; "resolved"?: string; "link"?: boolean } & Partial<Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>>> }): Record<string, Resolved> {
	const locked: Record<string, Resolved> = {};

	for (const [path, entry] of Object.entries(lock.packages ?? {}).toSorted(([one], [other]) => one.split("node_modules/").length - other.split("node_modules/").length)) {
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

		if (path.includes("node_modules/") && entry.version !== undefined && entry.link !== true && !(name in locked)) {
			const dependencies = Object.keys({ ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.dependencies }).toSorted();

			locked[name] = { "version": entry.version, "range": entry.version, ...entry.resolved?.startsWith("https://") === true ? { "tarball": entry.resolved } : {}, "dependencies": dependencies };
		}
	}

	return locked;
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
		const manifests = (await Promise.all(files.map(async (file) => read(file).catch(() => undefined)))).filter((manifest) => manifest !== undefined) as { "dependencies"?: Record<string, string>; "devDependencies"?: Record<string, string> }[];
		const roots: Record<string, string> = {};

		for (const manifest of manifests) {
			for (const [name, range] of Object.entries({ ...manifest.devDependencies, ...manifest.dependencies })) {
				roots[name] ??= range;
			}
		}

		const uri = vscode.Uri.file(`${root}/${versionsPath()}`);
		const before = await read(uri).catch(() => undefined) as VersionsFile | undefined;
		// (what was resolved stays, but a root whose range changed: resolved again, with what it now depends on)
		const known = Object.fromEntries(Object.entries(before?.from === "package.json" ? before.packages : {}).filter(([name, each]) => roots[name] === undefined || roots[name] === each.range));
		const packages = lock?.packages === undefined ? await resolveVersions(roots, { "known": known }) : lockedVersions(lock);
		const now: VersionsFile = { "resolvedAt": new Date().toISOString(), "minAgeDays": MIN_AGE_DAYS, "from": lock?.packages === undefined ? "package.json" : "package-lock.json", "packages": packages };

		if (before !== undefined && JSON.stringify(before.packages) === JSON.stringify(packages)) {
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
		console.error("[versions] couldn't be resolved:", error);

		return undefined;
	});

	return syncing;
}
