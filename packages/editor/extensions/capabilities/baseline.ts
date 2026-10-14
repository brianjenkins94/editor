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
 * And `consumer`: the project's own use of its dependencies — per workspace (each package.json's folder), which members
 * of each its code uses (lib's consumerOf) — from every source file's import surface, read by this extension's
 * TypeScript server plugin (`_capabilities.surface`) off the trees the server already holds. It changes with your code:
 * synced as code files change too. Until the server can answer, the consumer kept is left as it is.
 *
 * It's optional: `silo.baseline` off, none is made or synced, and the policy decides every package's call — what's lost
 * is tracking how the dependencies change over time, and how the project's use of them does.
 */
import type { Surface, SurfaceEntry, WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages, InstalledPackages } from "@brianjenkins94/util/silo/evidence";
import { add, consumerOf, surfaceEntries } from "@brianjenkins94/util/silo/detect";
import { syncPackages } from "@brianjenkins94/util/silo/evidence";
import { baselinePath, versionsPath } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";
import { tarballUrl } from "../../shared/tarball-url";

/** How many packages are read at once. */
const PARALLEL = 4;

/** What `.silo/baseline.json` holds: the project's use of its dependencies, and what each package can do (and what a
 *  later version of it grew). */
interface BaselineFile { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages }

/** How often, and how long apart, the consumer is asked for again while the TypeScript server isn't up yet. */
const RETRIES = 30;
const RETRY_MS = 2000;

/** How long code changes settle before the consumer is read again. */
const SETTLE_MS = 1500;

/** Code files, as silo audit walks them. */
const CODE = /\.[cm]?[jt]sx?$/u;

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

/**
 * The project's own use of its dependencies (lib's consumerOf): each source file's import surface, from this
 * extension's TypeScript server plugin, merged per workspace — its nearest package.json's folder, relative to `root`
 * ("." the root's); a nested private workspace governs itself and is left out, as are dot-folders, as silo audit walks
 * them — with each package's version as `.silo/versions.json` resolved it. Undefined while the server can't answer.
 */
async function consumerFor(root: vscode.Uri, versions: VersionsFile): Promise<Record<string, WsConsumer> | undefined> {
	const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "ready"?: boolean; "files"?: Record<string, Record<string, SurfaceEntry>> } } | undefined>("typescript.tsserverRequest", "_capabilities.surface", { "root": root.path })).catch(() => undefined);
	const answer = response?.body;

	if (answer?.ready !== true || answer.files === undefined) {
		return undefined;
	}

	const workspaces: { "dir": string; "private": boolean }[] = [];

	for (const uri of await vscode.workspace.findFiles("**/package.json", "{**/node_modules/**,**/.*/**}")) {
		const dir = uri.path.slice(root.path.length + 1, -"package.json".length).replace(/\/$/u, "") || ".";
		const manifest = await readJson(uri) as { "private"?: unknown } | undefined;

		workspaces.push({ "dir": dir, "private": dir !== "." && manifest?.private === true });
	}

	// (the deepest folder that has the file — the root's when none does)
	const owner = (path: string): { "dir": string; "private": boolean } => workspaces.filter(({ dir }) => dir !== "." && path.startsWith(dir + "/")).toSorted((one, other) => other.dir.length - one.dir.length)[0] ?? { "dir": ".", "private": false };
	const buckets = new Map<string, Surface>();

	for (const [path, surface] of Object.entries(answer.files)) {
		const workspace = owner(path);

		if (CODE.test(path) && !path.split("/").some((part) => part.startsWith(".")) && !workspace.private) {
			const bucket = buckets.get(workspace.dir) ?? new Map();

			buckets.set(workspace.dir, bucket);

			for (const [spec, use] of Object.entries(surface)) {
				for (const member of use.members) {
					add(bucket, spec, member);
				}

				add(bucket, spec, "", use.dynamic);
			}
		}
	}

	return consumerOf(Object.fromEntries([...buckets].map(([dir, surface]) => [dir, surfaceEntries(surface)])), (_workspace, pkg) => versions.packages[pkg]?.version);
}

/** `uri` as JSON, or undefined when there's none (or it isn't JSON). */
async function readJson(uri: vscode.Uri): Promise<unknown> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown, () => undefined);
}

/**
 * `.silo/baseline.json` (in `root`) made if there's none, else brought up to `.silo/versions.json` (lib's
 * syncPackages) and to the project's code (its `consumer`). A package that can't be read is left out, and said: its
 * calls are the policy's to decide. False when the consumer couldn't be read yet (the server isn't up): ask again.
 */
async function syncBaseline(context: vscode.ExtensionContext, root: vscode.Uri): Promise<boolean> {
	const versions = await readJson(vscode.Uri.joinPath(root, versionsPath())) as VersionsFile | undefined;

	if (versions === undefined) {
		return true; // not resolved yet: its writing syncs this
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
	const read = await consumerFor(root, versions);
	const consumer = read ?? existing?.consumer ?? {};
	const consumerChanged = JSON.stringify(consumer) !== JSON.stringify(existing?.consumer ?? {});

	if (existing !== undefined && changed.added.length + changed.updated.length + changed.grew.length === 0 && !consumerChanged) {
		return read !== undefined;
	}

	// (written as silo's saveBaseline writes it)
	const sorted = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));

	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ "consumer": consumer, "packages": sorted }, undefined, 2) + "\n"));

	tell(existing === undefined ? `made ${baselinePath()}: ${Object.keys(sorted).length} packages, from ${versions.from}` : `synced ${baselinePath()}${consumerChanged ? " (the code's use of its dependencies changed)" : ""}`, packages, changed, unread);

	return read !== undefined;
}

/** What a sync did, said in the extension host's log: what each package did, and what couldn't be read. */
function tell(what: string, packages: BaselinePackages, changed: ReturnType<typeof syncPackages>["changed"], unread: string[]): void {
	const grew = changed.grew.map((name) => `${name} (${Object.entries(packages[name].grew ?? {}).filter(([, version]) => version === packages[name].version).map(([capability]) => capability).join(", ")})`);

	console.info(`[baseline] ${what} — added: ${changed.added.join(", ") || "none"}; updated: ${changed.updated.join(", ") || "none"}; grew: ${grew.join(", ") || "none"}`);

	if (unread.length > 0) {
		console.warn(`[baseline] left out what couldn't be read — the policy decides these packages' calls: ${unread.join(", ")}`);
	}
}

/** Keep the baseline: synced now (the project opening), as `.silo/versions.json` changes (the dependencies did), as
 *  code files change (the consumer), and when `silo.baseline` is turned on — one sync at a time, one asked for
 *  meanwhile run after it. */
export function keepBaseline(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;

	if (root === undefined) {
		return;
	}

	const keeping = (): boolean => vscode.workspace.getConfiguration("silo").get<boolean>("baseline") !== false;
	let syncing: Promise<void> = Promise.resolve();
	let queued = false;
	let retries = 0;
	const sync = (): void => {
		if (queued || !keeping()) {
			return;
		}

		queued = true;
		syncing = syncing.then(async () => {
			queued = false;

			// (the TypeScript server not up yet: its consumer asked for again shortly)
			if (!await syncBaseline(context, root) && retries < RETRIES) {
				retries += 1;
				setTimeout(sync, RETRY_MS);
			}
		}).catch((error: unknown) => {
			console.error("[baseline] couldn't be synced:", error);
		});
	};

	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, versionsPath()));
	// The consumer changes with the code — however it changes (a save, the terminal, a checkout): synced once the
	// writes settle and the TypeScript server has seen them.
	const code = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"));
	let settling: ReturnType<typeof setTimeout> | undefined;
	const codeChanged = (uri: vscode.Uri): void => {
		if (!uri.path.includes("/node_modules/")) {
			clearTimeout(settling);
			settling = setTimeout(sync, SETTLE_MS);
		}
	};

	context.subscriptions.push(watcher, watcher.onDidCreate(sync), watcher.onDidChange(sync), vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("silo.baseline")) {
			sync();
		}
	}), code, code.onDidCreate(codeChanged), code.onDidChange(codeChanged), code.onDidDelete(codeChanged));
	sync();
}
