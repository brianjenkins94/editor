import type * as vscodeApi from "vscode";
import { failureText } from "@brianjenkins94/editor-api/failures";
import { keptAt, REFS_DIR } from "@brianjenkins94/editor-api/git";
import { tarballUrl } from "@brianjenkins94/editor-api/runtime";
import { SILO_DIR, versionsPath } from "@brianjenkins94/util/silo/layout";
import semver from "semver";
import { splitPackage } from "./node-modules-prefetch";
import { logger } from "@brianjenkins94/util/logger";
import { markReady } from "./readiness";

export const MIN_AGE_DAYS = 7;

const MODULE_NOT_FOUND = /^Cannot find module '([^']+)'/u;
const TYPES_NOT_FOUND = /^Cannot find type definition file for '([^']+)'/u;
const FILE_NOT_FOUND = /^File '([^']+)' not found/u;

export function packagesNotFound(message: string): string[] {
	const named = (MODULE_NOT_FOUND.exec(message) ?? FILE_NOT_FOUND.exec(message))?.[1];
	const types = TYPES_NOT_FOUND.exec(message)?.[1];

	if (types !== undefined) {
		const { pkg } = splitPackage(types);

		return [pkg, `@types/${pkg}`];
	}

	return named === undefined ? [] : [splitPackage(named).pkg];
}

const STALE_SETTLE_MS = 1000;

const STALE_SPACING_MS = 10_000;

const STALE_RELOADS = 3;

const log = logger({ "source": "workbench" });


export interface Resolved { "version": string; "range": string; "young"?: true; "tarball"?: string; "dependencies"?: string[]; "platform"?: true; "link"?: string; "alias"?: string; "nested"?: Record<string, string> }

export function aliasOf(range: string): { "name": string; "range": string } | undefined {
	const match = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@(.*))?$/u.exec(range);

	return match === null ? undefined : { "name": match[1]!, "range": match[2] ?? "latest" };
}

export const installsLocally = (each: Resolved): boolean => each.link !== undefined || (each.tarball !== undefined && !each.tarball.startsWith("https://registry.npmjs.org/"));

export const pinned: Record<string, string> = {};

export const installedLocally = new Set<string>();

export const aliases: Record<string, string> = {};

function repin(packages: Record<string, Resolved>): void {
	for (const name of Object.keys(pinned)) {
		delete pinned[name];
	}

	installedLocally.clear();

	for (const name of Object.keys(aliases)) {
		delete aliases[name];
	}

	for (const [name, each] of Object.entries(packages)) {
		if (installsLocally(each)) {
			installedLocally.add(name);
		} else {
			pinned[name] = each.version;

			if (each.alias !== undefined) {
				aliases[name] = each.alias;
			}
		}
	}
}

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

export interface VersionsFile { "resolvedAt": string; "minAgeDays": number; "from": "package-lock.json" | "package.json"; "format"?: number; "packages": Record<string, Resolved> }

const FORMAT = 3;

export interface Published { "version": string; "at": string; "latest"?: boolean }

const PARALLEL = 8;

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

const isPlatform = (manifest: { "os"?: unknown; "cpu"?: unknown }): boolean => (Array.isArray(manifest.os) && manifest.os.length > 0) || (Array.isArray(manifest.cpu) && manifest.cpu.length > 0);

async function manifestOf(name: string, version: string): Promise<{ "dependencies": Record<string, string>; "platform": boolean }> {
	const response = await fetch(`https://registry.npmjs.org/${name}/${version}`);

	if (!response.ok) {
		throw new Error(`registry: ${response.status} for ${name}@${version}`);
	}

	const manifest = await response.json() as Partial<Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>> & { "peerDependenciesMeta"?: Record<string, { "optional"?: boolean }>; "os"?: unknown; "cpu"?: unknown };
	const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([peer]) => manifest.peerDependenciesMeta?.[peer]?.optional !== true));

	return { "dependencies": { ...peers, ...manifest.optionalDependencies, ...manifest.dependencies }, "platform": isPlatform(manifest) };
}

export const resolvable = (range: string): boolean => !/^(?:file|link|workspace|git|git\+[a-z]+|https?|npm):|\//u.test(range);

export async function resolveVersions(roots: Record<string, string>, { minAgeDays = MIN_AGE_DAYS, now = Date.now(), known = {} }: { "minAgeDays"?: number; "now"?: number; "known"?: Record<string, Resolved> } = {}): Promise<Record<string, Resolved>> {
	const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
	const resolved: Record<string, Resolved> = { ...known };
	const queue: [string, string][] = Object.entries(roots);
	const ranges = new Map<string, Record<string, string>>();
	const unread = Object.entries(known).filter(([, each]) => each.dependencies === undefined);

	for (let at = 0; at < unread.length; at += PARALLEL) {
		await Promise.all(unread.slice(at, at + PARALLEL).map(async ([name, each]) => {
			const manifest = await manifestOf(each.alias ?? name, each.version).catch(() => undefined);

			if (manifest !== undefined) {
				resolved[name] = { ...each, "dependencies": Object.keys(manifest.dependencies).toSorted(), ...manifest.platform ? { "platform": true as const } : {} };
				ranges.set(name, manifest.dependencies);
				queue.push(...Object.entries<string>(manifest.dependencies));
			}
		}));
	}

	while (queue.length > 0) {
		const batch = queue.splice(0, PARALLEL).filter(([name, range], index, all) => !(name in resolved) && (resolvable(range) || aliasOf(range) !== undefined) && all.findIndex(([other]) => other === name) === index);

		await Promise.all(batch.map(async ([name, range]) => {
			try {
				const alias = aliasOf(range);
				const source = alias?.name ?? name;
				const chosen = choose(await published(source), alias?.range ?? range, cutoff);

				if (chosen !== undefined && !(name in resolved)) {
					const manifest = await manifestOf(source, chosen.version);

					resolved[name] ??= { "version": chosen.version, "range": range, ...chosen.young ? { "young": true as const } : {}, ...alias === undefined ? {} : { "alias": source, "tarball": tarballUrl(source, chosen.version) }, "dependencies": Object.keys(manifest.dependencies).toSorted(), ...manifest.platform ? { "platform": true as const } : {} };
					ranges.set(name, manifest.dependencies);
					queue.push(...Object.entries<string>(manifest.dependencies));
				}
			} catch {
			}
		}));
	}

	await nestUnsatisfied(resolved, ranges, cutoff);

	return Object.fromEntries(Object.entries(resolved).toSorted(([one], [other]) => one.localeCompare(other)));
}

export async function nestUnsatisfied(resolved: Record<string, Resolved>, ranges: Map<string, Record<string, string>>, cutoff: number): Promise<void> {
	const wanted = [...ranges].flatMap(([parent, dependencies]) => Object.entries(dependencies).filter(([name, range]) => {
		const kept = resolved[name];

		return kept !== undefined && kept.link === undefined && kept.alias === undefined && resolvable(range) && semver.validRange(range) !== null && !semver.satisfies(kept.version, range, { "includePrerelease": true });
	}).map(([name, range]) => ({ "parent": parent, "name": name, "range": range })));

	for (let at = 0; at < wanted.length; at += PARALLEL) {
		await Promise.all(wanted.slice(at, at + PARALLEL).map(async ({ parent, name, range }) => {
			const chosen = choose(await published(name).catch(() => []), range, cutoff);

			if (chosen !== undefined && resolved[parent] !== undefined) {
				resolved[parent] = { ...resolved[parent], "nested": { ...resolved[parent].nested, [name]: chosen.version } };
			}
		}));
	}
}

export function lockedVersions(lock: { "packages"?: Record<string, { "version"?: string; "resolved"?: string; "link"?: boolean; "os"?: unknown; "cpu"?: unknown } & Partial<Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>>> }, dir = ""): Record<string, Resolved> {
	const locked: Record<string, Resolved> = {};

	for (const [path, entry] of Object.entries(lock.packages ?? {}).toSorted(([one], [other]) => one.split("node_modules/").length - other.split("node_modules/").length)) {
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

		if (path.includes("node_modules/") && entry.link === true && entry.resolved !== undefined && !(name in locked)) {
			locked[name] = { "version": entry.version ?? "0.0.0", "range": `file:${entry.resolved}`, "link": linkedFolder(dir, entry.resolved) };
		} else if (path.includes("node_modules/") && entry.version !== undefined && entry.link !== true && !(name in locked)) {
			const dependencies = Object.keys({ ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.dependencies }).toSorted();

			locked[name] = { "version": entry.version, "range": entry.version, ...entry.resolved?.startsWith("https://") === true ? { "tarball": entry.resolved } : {}, "dependencies": dependencies, ...isPlatform(entry) ? { "platform": true as const } : {} };
		} else if (entry.version !== undefined && entry.link !== true && /^node_modules\/((?:@[^/]+\/)?[^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)$/u.test(path)) {
			const [, parent] = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(path)!;

			if (locked[parent!] !== undefined && locked[name]?.version !== entry.version) {
				locked[parent!] = { ...locked[parent!], "nested": { ...locked[parent!].nested, [name]: entry.version } };
			}
		}
	}

	return locked;
}

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

async function installOwn(vscode: typeof vscodeApi, root: string, dependencies: Record<string, Resolved>, known: Record<string, Resolved>): ReturnType<typeof import("./install").install> {
	const ours = Object.fromEntries(Object.entries(dependencies).filter(([, each]) => installsLocally(each)).map(([name, each]): [string, Resolved] => [name, known[name]?.range === each.range ? known[name] : each]));
	const { install } = await import("./install");

	for (const name of Object.keys(ours)) {
		installedLocally.add(name);
	}

	return install(vscode, root, ours);
}

let syncing: Promise<VersionsFile | undefined> = Promise.resolve(undefined);
let queued = false;

export function syncVersions(vscode: typeof vscodeApi, root = "/workspace"): Promise<VersionsFile | undefined> {
	if (queued) {
		return syncing;
	}

	queued = true;
	syncing = syncing.then(async () => {
		queued = false;

		const read = async (file: vscodeApi.Uri): Promise<unknown> => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as unknown;
		const lock = await read(vscode.Uri.file(`${root}/package-lock.json`)).catch(() => undefined) as Parameters<typeof lockedVersions>[0] | undefined;
		const files = (await vscode.workspace.findFiles("**/package.json", `{**/node_modules/**,**/${SILO_DIR}/**,${REFS_DIR}/**}`)).toSorted((one, other) => one.path.length - other.path.length);
		const { roots, local } = dependenciesOf(await Promise.all(files.map(async (file) => ({ "dir": file.path.slice(root.length + 1, file.path.lastIndexOf("/")), "manifest": await read(file).catch(() => undefined) }))));

		const at = await keptAt(versionsPath(), async (path) => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`${root}/${path}`))).then(() => true, () => false));
		const uri = vscode.Uri.file(`${root}/${at}`);
		const before = await read(uri).catch(() => undefined) as VersionsFile | undefined;
		const kept = Object.entries(before?.from === "package.json" ? before.packages : {}).filter(([name, each]) => (roots[name] ?? local[name]?.range) === undefined || (roots[name] ?? local[name]?.range) === each.range);
		const known = Object.fromEntries(before?.format === FORMAT ? kept : kept.map(([name, { "dependencies": _, ...each }]) => [name, each]));
		const locked = lock?.packages === undefined ? undefined : lockedVersions(lock);
		const { installed, wants, changed } = await installOwn(vscode, root, { ...locked, ...local }, known);
		const from = lock?.packages === undefined ? "package.json" : "package-lock.json";
		const file = (packages: Record<string, Resolved>): VersionsFile => ({ "resolvedAt": new Date().toISOString(), "minAgeDays": MIN_AGE_DAYS, "from": from, "format": FORMAT, "packages": packages });
		const linked = { ...before?.packages, ...installed };

		if (JSON.stringify(linked) !== JSON.stringify(before?.packages)) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(file(linked), undefined, 2) + "\n"));
		}

		if (changed) {
			void vscode.commands.executeCommand("typescript.reloadProjects");
		}

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

export function watchVersions(vscode: typeof vscodeApi): vscodeApi.Disposable {
	const watcher = vscode.workspace.createFileSystemWatcher("**/{package.json,package-lock.json}");
	const changed = (uri: vscodeApi.Uri): void => {
		if (!uri.path.includes("/node_modules/")) {
			void syncVersions(vscode);
		}
	};

	const reloads = new Map<string, number>();
	let lastReload = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const stale = (): void => {
		const missing = [...new Set(vscode.languages.getDiagnostics().flatMap(([, diagnostics]) => diagnostics).filter((diagnostic) => diagnostic.source === "ts").flatMap((diagnostic) => packagesNotFound(diagnostic.message)))].filter((name) => pinned[name] !== undefined && (reloads.get(name) ?? 0) < STALE_RELOADS);

		if (missing.length === 0) {
			return;
		}

		const wait = lastReload + STALE_SPACING_MS - performance.now();

		if (wait > 0) {
			clearTimeout(pending);
			pending = setTimeout(stale, wait);

			return;
		}

		for (const name of missing) {
			reloads.set(name, (reloads.get(name) ?? 0) + 1);
		}

		lastReload = performance.now();
		log.info("TypeScript can't find packages that are pinned: its projects reloaded", { "packages": missing.join(","), "tries": Math.max(...missing.map((name) => reloads.get(name) ?? 0)) });
		void vscode.commands.executeCommand("typescript.reloadProjects");
		clearTimeout(pending);
		pending = setTimeout(stale, STALE_SPACING_MS);
	};
	const listeners = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed), vscode.languages.onDidChangeDiagnostics(() => {
		clearTimeout(pending);
		pending = setTimeout(stale, STALE_SETTLE_MS);
	})];

	void syncVersions(vscode).then(() => {
		markReady("versions");
		stale();
	});

	return new vscode.Disposable(() => {
		for (const listener of [...listeners, watcher]) {
			listener.dispose();
		}
	});
}
