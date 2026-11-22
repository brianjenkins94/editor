import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Surface, SurfaceEntry, WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages, InstalledPackages } from "@brianjenkins94/util/silo/evidence";
import { failureText, watchWorker } from "@brianjenkins94/editor-api/failures";
import { keptAt, localOf } from "@brianjenkins94/editor-api/git";
import { tarballUrl } from "@brianjenkins94/editor-api/runtime";
import { add, consumerOf, surfaceEntries } from "@brianjenkins94/util/silo/detect";
import { JOIN, joinedBefore, joinsWanted, syncConsumer, syncPackages } from "@brianjenkins94/util/silo/evidence";
import { resolvedSince } from "./resolved";
import { baselinePath, LOCAL_DIR, versionsPath } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

const PARALLEL = 4;

interface BaselineFile { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages; "join"?: number }

interface Slice { "key": string; "spec": string; "members": string[] }

const RETRIES = 30;
const RETRY_MS = 2000;

const SETTLE_MS = 1500;

const CODE = /\.[cm]?[jt]sx?$/u;

interface VersionsFile { "from": string; "packages": Record<string, { "version": string; "tarball"?: string; "platform"?: true; "link"?: string }> }

function packageWorker(context: vscode.ExtensionContext): { "read": (url: string, name: string, slices: Slice[]) => Promise<{ "caps": string[]; "slices": Record<string, string[] | null> }>; "end": () => void } {
	const worker = new Worker(vscode.Uri.joinPath(context.extensionUri, "packages.js").toString(true), { "name": "packages" });
	const pending = new Map<number, { "resolve": (answer: { "caps": string[]; "slices": Record<string, string[] | null> }) => void; "reject": (error: Error) => void }>();
	let next = 0;
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
	watchWorker(worker, "packages-worker", (message) => {
		failAll("the package worker failed: " + message);
	});
	worker.addEventListener("message", (event: MessageEvent) => {
		const { id, caps, slices, error, failed, "ready": isReady } = event.data as { "id"?: number; "caps"?: string[]; "slices"?: Record<string, string[] | null>; "error"?: string; "failed"?: string; "ready"?: true };

		if (isReady === true) {
			markReady();

			return;
		}

		if (failed !== undefined) {
			return;
		}

		const call = pending.get(id ?? -1);

		pending.delete(id ?? -1);

		if (caps === undefined) {
			call?.reject(new Error(error ?? "no answer"));
		} else {
			call?.resolve({ "caps": caps, "slices": slices ?? {} });
		}
	});

	return {
		"read": async (url, name, slices) => {
			await ready;

			return new Promise((resolve, reject) => {
				next += 1;
				pending.set(next, { "resolve": resolve, "reject": reject });
				worker.postMessage({ "id": next, "url": url, "name": name, "slices": slices });
			});
		},
		"end": () => {
			failAll("the sync ended");
			worker.terminate();
		}
	};
}

type Surfaces = Record<string, Record<string, SurfaceEntry>>;

interface ReadFrom { "files": Surfaces; "pending": string[] }

async function codeFiles(root: vscode.Uri): Promise<string[]> {
	return (await vscode.workspace.findFiles("**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}", "{**/node_modules/**,**/.*/**}")).map((uri) => uri.path.slice(root.path.length + 1));
}

async function surfacesNow(root: vscode.Uri): Promise<Surfaces | undefined> {
	const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "ready"?: boolean; "files"?: Surfaces } } | undefined>("typescript.tsserverRequest", "_capabilities.surface", { "root": root.path })).catch(() => undefined);
	const answer = response?.body;

	if (answer?.ready !== true || answer.files === undefined) {
		return undefined;
	}

	return Object.fromEntries(Object.entries(answer.files).filter(([path]) => CODE.test(path) && !path.split("/").some((part) => part.startsWith(".")))) as Surfaces;
}

async function workspacesOf(root: vscode.Uri): Promise<{ "dir": string; "private": boolean }[]> {
	const workspaces: { "dir": string; "private": boolean }[] = [];

	for (const uri of await vscode.workspace.findFiles("**/package.json", "{**/node_modules/**,**/.*/**}")) {
		const dir = uri.path.slice(root.path.length + 1, -"package.json".length).replace(/\/$/u, "") || ".";
		const manifest = await readJson(uri) as { "private"?: unknown } | undefined;

		workspaces.push({ "dir": dir, "private": dir !== "." && manifest?.private === true });
	}

	return workspaces;
}

function consumerFrom(surfaces: Surfaces, workspaces: { "dir": string; "private": boolean }[], versions: VersionsFile): Record<string, WsConsumer> {
	const owner = (path: string): { "dir": string; "private": boolean } => workspaces.filter(({ dir }) => dir !== "." && path.startsWith(dir + "/")).toSorted((one, other) => other.dir.length - one.dir.length)[0] ?? { "dir": ".", "private": false };
	const buckets = new Map<string, Surface>();

	for (const [path, surface] of Object.entries(surfaces)) {
		const workspace = owner(path);

		if (!workspace.private) {
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

async function consumerFor(root: vscode.Uri, versions: VersionsFile, existing: BaselineFile | undefined, kept: ReadFrom | undefined): Promise<{ "read": Record<string, WsConsumer>; "seen": Record<string, WsConsumer>; "fresh": boolean; "keep": ReadFrom } | undefined> {
	const now = await surfacesNow(root);

	if (now === undefined) {
		return undefined;
	}

	const there = new Set(await codeFiles(root));
	const fresh = existing === undefined || kept === undefined;
	const pending = new Set(fresh ? there : kept.pending);
	const files = Object.fromEntries(Object.entries({ ...fresh ? {} : kept.files, ...now }).filter(([path]) => there.has(path)));
	const firstRead = new Set(Object.keys(now).filter((path) => pending.has(path)));
	const workspaces = await workspacesOf(root);

	return {
		"read": consumerFrom(files, workspaces, versions),
		"seen": consumerFrom(Object.fromEntries(Object.entries(files).filter(([path]) => !firstRead.has(path))), workspaces, versions),
		"fresh": fresh,
		"keep": { "files": files, "pending": [...pending].filter((path) => there.has(path) && !(path in now)).sort() }
	};
}

async function readJson(uri: vscode.Uri): Promise<unknown> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown, () => undefined);
}

function slicesOf(read: Record<string, WsConsumer> | undefined, existing: BaselineFile | undefined, resolved: VersionsFile["packages"]): Map<string, Slice[]> {
	return new Map([...read === undefined ? [] : joinsWanted(read, existing)].filter(([name]) => resolved[name] !== undefined).map(([name, slices]) => [name, slices.map((slice) => ({ "key": slice.workspace + "\n" + slice.spec, "spec": slice.spec, "members": slice.members }))]));
}

async function readPackages(context: vscode.ExtensionContext, resolved: VersionsFile["packages"], known: BaselinePackages, slices: Map<string, Slice[]>, read: Record<string, WsConsumer> | undefined): Promise<{ "installed": InstalledPackages; "unread": string[] }> {
	const installed: InstalledPackages = {};
	const unread: string[] = [];
	const wanted = Object.entries(resolved).filter(([name, { version }]) => {
		const same = known[name]?.version === version;

		if (same) {
			installed[name] = { "version": version, "caps": known[name].caps };
		}

		return !same || slices.has(name);
	});

	if (wanted.length === 0) {
		return { "installed": installed, "unread": unread };
	}

	const worker = packageWorker(context);

	try {
		for (let at = 0; at < wanted.length; at += PARALLEL) {
			await Promise.all(wanted.slice(at, at + PARALLEL).map(async ([name, { version, tarball }]) => {
				try {
					const answer = await worker.read(tarballUrl(name, version, tarball), name, slices.get(name) ?? []);

					installed[name] = { "version": version, "caps": answer.caps };

					for (const slice of slices.get(name) ?? []) {
						const entry = read?.[slice.key.split("\n")[0]]?.[slice.spec];

						if (entry !== undefined) {
							entry.caps = answer.slices[slice.key] ?? answer.caps;
						}
					}
				} catch (error) {
					unread.push(`${name}@${version} (${error instanceof Error ? error.message : String(error)})`);
				}
			}));
		}
	} finally {
		worker.end();
	}

	return { "installed": installed, "unread": unread };
}

function consumerNow(existing: BaselineFile | undefined, use: Awaited<ReturnType<typeof consumerFor>>, added: ReadonlySet<string>): { "consumer": Record<string, WsConsumer>; "join"?: number } {
	if (use === undefined) {
		return { "consumer": existing?.consumer ?? {}, ...existing?.join === undefined ? {} : { "join": existing.join } };
	}

	return { "consumer": syncConsumer(use.fresh ? undefined : resolvedSince(joinedBefore(existing), use.read), use.read, added, use.seen).consumer, "join": JOIN };
}


async function syncBaseline(context: vscode.ExtensionContext, root: vscode.Uri, log: ObservedExtension["log"] | undefined): Promise<boolean> {
	const there = async (path: string): Promise<boolean> => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, path))).then(() => true, () => false);
	const versions = await readJson(vscode.Uri.joinPath(root, await keptAt(versionsPath(), there))) as VersionsFile | undefined;

	if (versions === undefined) {
		return true; // not resolved yet: its writing syncs this
	}

	const uri = vscode.Uri.joinPath(root, await keptAt(baselinePath(), there));
	const existing = await readJson(uri) as BaselineFile | undefined;
	const known = existing?.packages ?? {};
	const resolved = Object.fromEntries(Object.entries(versions.packages).filter(([, each]) => each.platform !== true && each.link === undefined));

	if (Object.keys(resolved).length === 0 && existing === undefined) {
		return true;
	}
	const readFrom = vscode.Uri.joinPath(root, LOCAL_DIR, "baseline-files.json");
	const use = await consumerFor(root, versions, existing, await readJson(readFrom) as ReadFrom | undefined);
	const read = use?.read;
	const slices = slicesOf(read, existing, resolved);
	const { installed, unread } = await readPackages(context, resolved, known, slices, read);
	const { packages, changed } = syncPackages(known, installed);
	const { consumer, join } = consumerNow(existing, use, new Set(changed.added));

	if (use !== undefined) {
		await vscode.workspace.fs.writeFile(readFrom, new TextEncoder().encode(JSON.stringify(use.keep) + "\n"));
	}

	const consumerChanged = JSON.stringify(consumer) !== JSON.stringify(existing?.consumer ?? {});

	const packagesChanged = changed.added.length + changed.updated.length + changed.grew.length > 0;

	if (existing !== undefined && !packagesChanged && !consumerChanged && existing.join === join) {
		return read !== undefined;
	}

	const sorted = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));

	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ "consumer": consumer, "packages": sorted, ...join === undefined ? {} : { "join": join } }, undefined, 2) + "\n"));

	tell(log, existing === undefined ? `made ${baselinePath()}: ${String(Object.keys(sorted).length)} packages, from ${versions.from}` : `synced ${baselinePath()}${consumerChanged ? " (the code's use of its dependencies changed)" : ""}`, packages, changed, unread);

	return read !== undefined;
}

function tell(log: ObservedExtension["log"] | undefined, what: string, packages: BaselinePackages, changed: ReturnType<typeof syncPackages>["changed"], unread: string[]): void {
	const grew = changed.grew.map((name) => `${name} (${Object.entries(packages[name]!.grew ?? {}).filter(([, version]) => version === packages[name]!.version).map(([capability]) => capability).join(", ")})`);

	log?.info(what, { "added": changed.added.join(", ") || "none", "updated": changed.updated.join(", ") || "none", "grew": grew.join(", ") || "none" });

	if (unread.length > 0) {
		log?.warn("the baseline left out what couldn't be read: the policy decides these packages' calls", { "unread": unread.join(", ") });
	}
}

export function keepBaseline(context: vscode.ExtensionContext, log?: ObservedExtension["log"]): void {
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

			const read = log === undefined ? await syncBaseline(context, root, log) : await log.span("editor.extensions.capabilities.baseline.sync", {}, async () => syncBaseline(context, root, log));

			if (!read && retries < RETRIES) {
				retries += 1;
				setTimeout(sync, RETRY_MS);
			}
		}).catch((error: unknown) => {
			log?.error("the baseline couldn't be synced", { "error": failureText(error) });
		});
	};

	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `{${versionsPath()},${localOf(versionsPath())}}`));
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
