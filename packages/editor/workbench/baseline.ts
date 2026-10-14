/**
 * The dependency-capability baseline (`.silo/baseline.json`, lib's util/silo/audit.ts `Baseline`), kept by the editor —
 * its `silo init`: what each library the project depends on can do, read off its own code as it's added. Made on the
 * first run that keeps evidence, then synced as the dependencies change (lib's syncPackages): a library added is taken
 * as it is; a new version that can do more records what it grew, and that asks at the call unless the policy allows it.
 * Runs never change it — a compromised version would approve itself; what's decided at the call, beyond it, is
 * recorded in the runs instead (their effects' `decided`).
 *
 * The packages are the ones the project loads, by name@version — the shared resolver's (versions.ts): a
 * package-lock.json's, else each package.json's dependency ranges resolved with nothing younger than a week. What each can
 * do is lib's `detect` over the code files of its published tarball (npm's registry) — its own files, as
 * installedPackages reads them on desktop, never what it depends on (each dependency is its own entry). There's no
 * node_modules to walk here: the editor serves packages from a CDN.
 *
 * `consumer` (what the project's own code imports, and how) isn't made here — desktop silo's establishBaseline does.
 */
import type { BaselinePackages, InstalledPackages } from "@brianjenkins94/util/silo/evidence";
import type * as vscodeApi from "vscode";
import { detect } from "@brianjenkins94/util/silo/detect";
import { syncPackages } from "@brianjenkins94/util/silo/evidence";
import { packageFiles } from "./tarballs";
import { syncVersions } from "./versions";
import { baselinePath } from "@brianjenkins94/util/silo/layout";

/** A package to read: by name and exact version, and its tarball (a lockfile's `resolved`, else the registry's). */
interface Wanted { "name": string; "version": string; "tarball"?: string }

/** How many packages are fetched and read at once. */
const PARALLEL = 4;

/** A tarball's code files: what detect reads. */
const CODE = /\.[cm]?js$/u;

/** What `name`@`version`'s own code can do: detect over each of its tarball's code files. */
async function capsOf(name: string, version: string, tarball?: string): Promise<string[]> {
	const caps = new Set<string>();
	const decoder = new TextDecoder();

	for (const bytes of (await packageFiles(name, version, tarball, (path) => CODE.test(path))).values()) {
		for (const cap of detect(decoder.decode(bytes))) {
			caps.add(cap);
		}
	}

	return [...caps].toSorted();
}

/** One sync at a time; one asked for while one runs is run after it (what changed meanwhile is then seen). */
let syncing: Promise<void> = Promise.resolve();
let queued = false;

/** What `.silo/baseline.json` holds: what each package can do, and what a later version of it grew. */
interface BaselineFile { "consumer"?: unknown; "packages"?: BaselinePackages }

/**
 * `.silo/baseline.json` (at `root`) made if there's none, else brought up to what the project would install now (lib's
 * syncPackages): a library added is taken as its code is; a new version that can do more records what it grew, which
 * asks at the call unless the policy allows it. What a package can do is read from its tarball only when it's new or its
 * version is — the version in the baseline is known. Runs never change it.
 * A package that can't be read is left out, and said: its calls will read as a package the baseline doesn't have.
 * `make`: false syncs one that's there and makes none (a dependency changing in a workspace that doesn't keep one).
 */
export function syncBaseline(vscode: typeof vscodeApi, make = true, root = "/workspace"): Promise<void> {
	if (queued) {
		return syncing;
	}

	queued = true;
	syncing = syncing.then(async () => {
		queued = false;

		const uri = vscode.Uri.file(`${root}/${baselinePath()}`);
		const read = async (file: vscodeApi.Uri): Promise<unknown> => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as unknown;
		const existing = await read(uri).catch(() => undefined) as BaselineFile | undefined;

		if (existing === undefined && !make) {
			return;
		}

		const known = existing?.packages ?? {};
		// (the versions everything loads — the resolver's: versions.ts)
		const versions = await syncVersions(vscode, root);

		if (versions === undefined) {
			return;
		}

		const wanted: Wanted[] = Object.entries(versions.packages).map(([name, each]) => ({ "name": name, "version": each.version, ...each.tarball === undefined ? {} : { "tarball": each.tarball } }));
		const installed: InstalledPackages = {};
		const unread: string[] = [];

		for (let at = 0; at < wanted.length; at += PARALLEL) {
			await Promise.all(wanted.slice(at, at + PARALLEL).map(async ({ name, version, tarball }) => {
				const caps = known[name]?.version === version ? known[name].caps : undefined;

				try {
					installed[name] = { "version": version, "caps": caps ?? await capsOf(name, version, tarball) };
				} catch (error) {
					unread.push(`${name}@${version} (${error instanceof Error ? error.message : String(error)})`);
				}
			}));
		}

		const { packages, changed } = syncPackages(known, installed);

		if (existing !== undefined && changed.added.length + changed.updated.length + changed.grew.length === 0) {
			return;
		}

		// (written as silo's saveBaseline writes it; `consumer` — the project's own imports — is desktop silo's to make)
		const sorted = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));

		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ "consumer": existing?.consumer ?? {}, "packages": sorted }, undefined, 2) + "\n"));

		if (existing === undefined) {
			console.info(`[baseline] made ${baselinePath()}: ${Object.keys(sorted).length} packages, from ${versions.from}`);
		} else {
			console.info(`[baseline] synced ${baselinePath()} — added: ${changed.added.join(", ") || "none"}; updated: ${changed.updated.join(", ") || "none"}; grew: ${changed.grew.map((name) => `${name} (${Object.entries(packages[name].grew ?? {}).filter(([, version]) => version === packages[name].version).map(([capability]) => capability).join(", ")})`).join(", ") || "none"}`);
		}

		if (unread.length > 0) {
			console.warn(`[baseline] left out what couldn't be read — a run's calls by these will read as packages the baseline doesn't have: ${unread.join(", ")}`);
		}
	}).catch((error: unknown) => {
		console.error("[baseline] couldn't be synced:", error);
	});

	return syncing;
}

/** Keep the versions (versions.ts) and `.silo/baseline.json` up to the project's dependencies: both resolved again as a
 *  package.json or package-lock.json changes — the baseline when there's one (the first run that keeps evidence makes
 *  it) — and the versions now, so a preview started before any run pins them. */
export function watchBaseline(vscode: typeof vscodeApi): vscodeApi.Disposable {
	const watcher = vscode.workspace.createFileSystemWatcher("**/{package.json,package-lock.json}");
	const changed = (uri: vscodeApi.Uri): void => {
		if (!uri.path.includes("/node_modules/")) {
			void syncVersions(vscode).then(async () => syncBaseline(vscode, false));
		}
	};

	void syncVersions(vscode);

	const listeners = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];

	return { "dispose": () => {
		for (const listener of [...listeners, watcher]) {
			listener.dispose();
		}
	} };
}
