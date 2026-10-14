/**
 * The dependency baseline (`.silo/baseline.json`, lib's util/silo/audit.ts `Baseline`), kept by this extension — the
 * editor's `silo init` and `silo install`: what each library the project depends on can do, read off its own code as
 * it's added. Made as the project opens, then synced as the dependencies change (lib's syncPackages): a library added is
 * taken as it is; a new version that can do more records what it grew, and that asks at the call unless the policy
 * allows it. Runs never change it — a compromised version would approve itself; what's decided at the call, beyond it,
 * is recorded in the runs instead (their effects' `decided`).
 *
 * The packages are the ones the project loads, by name@version — the editor's resolver's, in `.silo/versions.json` (the
 * workbench keeps it: a package-lock.json's versions, else each package.json's ranges resolved with nothing younger than
 * a week); a change to that file is a change to the dependencies. What each can do is lib's packageCaps over its
 * published tarball — its own files, as installedPackages reads them on desktop, never what it depends on (each
 * dependency is its own entry) — read in a worker of this extension's (packages-worker.ts), started for a sync and ended
 * after it. Only a package that's new, or at a new version, is read.
 *
 * `consumer` (what the project's own code imports, and how) isn't made here — desktop silo's establishBaseline does.
 *
 * It's optional: `silo.baseline` off, none is made or synced, and the policy decides every package's call — what's lost
 * is tracking how the dependencies change over time, and how the project's use of them does.
 */
import type { BaselinePackages, InstalledPackages } from "@brianjenkins94/util/silo/evidence";
import { syncPackages } from "@brianjenkins94/util/silo/evidence";
import { baselinePath, versionsPath } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";
import { tarballUrl } from "../../shared/tarball-url";

/** How many packages are read at once. */
const PARALLEL = 4;

/** What `.silo/baseline.json` holds: what each package can do, and what a later version of it grew. */
interface BaselineFile { "consumer"?: unknown; "packages"?: BaselinePackages }

/** What this reads of `.silo/versions.json` (the workbench's versions.ts `VersionsFile`). */
interface VersionsFile { "from": string; "packages": Record<string, { "version": string; "tarball"?: string }> }

/** The package worker, started for one sync: each package's capabilities, by its tarball's URL; `end` stops it. */
function packageWorker(context: vscode.ExtensionContext): { "capsOf": (url: string) => Promise<string[]>; "end": () => void } {
	// (packages.js is a classic bootstrap importing the module worker by its URL, so its own imports resolve beside it)
	const worker = new Worker(vscode.Uri.joinPath(context.extensionUri, "packages.js").toString(true), { "name": "packages" });
	const pending = new Map<number, { "resolve": (caps: string[]) => void; "reject": (error: Error) => void }>();
	let next = 0;
	// (asked only once it listens: what's sent before its module loads is lost)
	let markReady: () => void = () => undefined;
	let markFailed: (error: Error) => void = () => undefined;
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		markFailed = reject;
	});
	const failAll = (why: string): void => {
		markFailed(new Error(why));

		for (const call of pending.values()) {
			call.reject(new Error(why));
		}

		pending.clear();
	};

	ready.catch(() => undefined);
	worker.addEventListener("message", (event: MessageEvent) => {
		const { id, caps, error, failed, "ready": isReady } = event.data as { "id"?: number; "caps"?: string[]; "error"?: string; "failed"?: string; "ready"?: true };

		if (isReady === true) {
			markReady();

			return;
		}

		if (failed !== undefined) {
			failAll("the package worker couldn't start: " + failed);

			return;
		}

		const call = pending.get(id ?? -1);

		pending.delete(id ?? -1);

		if (caps === undefined) {
			call?.reject(new Error(error ?? "no answer"));
		} else {
			call?.resolve(caps);
		}
	});
	worker.addEventListener("error", (event) => {
		event.preventDefault();
		failAll("the package worker failed: " + (event.message || "it couldn't load"));
	});

	return {
		"capsOf": async (url) => {
			await ready;

			return new Promise<string[]>((resolve, reject) => {
				next += 1;
				pending.set(next, { "resolve": resolve, "reject": reject });
				worker.postMessage({ "id": next, "url": url });
			});
		},
		"end": () => {
			failAll("the sync ended");
			worker.terminate();
		}
	};
}

/** `uri` as JSON, or undefined when there's none (or it isn't JSON). */
async function readJson(uri: vscode.Uri): Promise<unknown> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown, () => undefined);
}

/**
 * `.silo/baseline.json` (in `root`) made if there's none, else brought up to `.silo/versions.json` (lib's
 * syncPackages). A package that can't be read is left out, and said: its calls are the policy's to decide.
 */
async function syncBaseline(context: vscode.ExtensionContext, root: vscode.Uri): Promise<void> {
	const versions = await readJson(vscode.Uri.joinPath(root, versionsPath())) as VersionsFile | undefined;

	if (versions === undefined) {
		return; // not resolved yet: its writing syncs this
	}

	const uri = vscode.Uri.joinPath(root, baselinePath());
	const existing = await readJson(uri) as BaselineFile | undefined;
	const known = existing?.packages ?? {};
	const installed: InstalledPackages = {};
	const wanted: { "name": string; "version": string; "url": string }[] = [];

	for (const [name, { version, tarball }] of Object.entries(versions.packages)) {
		if (known[name]?.version === version) {
			installed[name] = { "version": version, "caps": known[name].caps };
		} else {
			wanted.push({ "name": name, "version": version, "url": tarballUrl(name, version, tarball) });
		}
	}

	const unread: string[] = [];

	if (wanted.length > 0) {
		const worker = packageWorker(context);

		try {
			for (let at = 0; at < wanted.length; at += PARALLEL) {
				await Promise.all(wanted.slice(at, at + PARALLEL).map(async ({ name, version, url }) => {
					try {
						installed[name] = { "version": version, "caps": await worker.capsOf(url) };
					} catch (error) {
						unread.push(`${name}@${version} (${error instanceof Error ? error.message : String(error)})`);
					}
				}));
			}
		} finally {
			worker.end();
		}
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
		console.warn(`[baseline] left out what couldn't be read — the policy decides these packages' calls: ${unread.join(", ")}`);
	}
}

/** Keep the baseline: synced now (the project opening), as `.silo/versions.json` changes (the dependencies did), and
 *  when `silo.baseline` is turned on — one sync at a time, one asked for meanwhile run after it. */
export function keepBaseline(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;

	if (root === undefined) {
		return;
	}

	const keeping = (): boolean => vscode.workspace.getConfiguration("silo").get<boolean>("baseline") !== false;
	let syncing: Promise<void> = Promise.resolve();
	let queued = false;
	const sync = (): void => {
		if (queued || !keeping()) {
			return;
		}

		queued = true;
		syncing = syncing.then(async () => {
			queued = false;
			await syncBaseline(context, root);
		}).catch((error: unknown) => {
			console.error("[baseline] couldn't be synced:", error);
		});
	};

	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, versionsPath()));

	context.subscriptions.push(watcher, watcher.onDidCreate(sync), watcher.onDidChange(sync), vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("silo.baseline")) {
			sync();
		}
	}));
	sync();
}
