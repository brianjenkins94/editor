/**
 * The dependency-capability baseline (`.silo/baseline.json`, lib's util/silo/audit.ts `Baseline`), kept by the editor —
 * its `silo init`: what each library the project depends on can do, read off its own code as it's added. Made on the
 * first run that keeps evidence, then synced as the dependencies change (lib's syncPackages): a library added is accepted
 * as it is; a new version that can do more is pending until a person accepts it, and meanwhile what's new in it asks at
 * the call. Runs never change it — a compromised version would approve itself; what's decided at the call, beyond it, is
 * recorded in the runs instead (their effects' `decided`).
 *
 * The packages are the ones the project would install, by name@version: a package-lock.json's, where there is one; else
 * each package.json's dependency ranges resolved as the preview resolves them (esm.sh), and theirs in turn. What each can
 * do is lib's `detect` over the code files of its published tarball (npm's registry) — its own files, as
 * installedPackages reads them on desktop, never what it depends on (each dependency is its own entry). There's no
 * node_modules to walk here: the editor serves packages from a CDN.
 *
 * `consumer` (what the project's own code imports, and how) isn't made here — desktop silo's establishBaseline does.
 */
import type { AcceptedPackages } from "@brianjenkins94/util/silo/evidence";
import type * as vscodeApi from "vscode";
import { detect } from "@brianjenkins94/util/silo/detect";
import { syncPackages } from "@brianjenkins94/util/silo/evidence";
import { baselinePath, SILO_DIR } from "@brianjenkins94/util/silo/layout";

/** A package as the baseline accepts it: its version, and what its own code can do. */
interface Accepted { "version": string; "caps": string[] }

/** A package to read: by name and exact version, and its tarball (a lockfile's `resolved`, else the registry's). */
interface Wanted { "name": string; "version": string; "tarball"?: string }

/** How many packages are fetched and read at once. */
const PARALLEL = 4;

/** A tarball's code files, by path (under `package/`): what detect reads. */
const CODE = /\.[cm]?js$/u;

/** The code files' texts in a .tgz: gunzipped, then its tar entries read (ustar, with pax and GNU long names). */
export async function tarballTexts(gzipped: ReadableStream<Uint8Array>, wanted: (path: string) => boolean = (path) => CODE.test(path)): Promise<Map<string, string>> {
	// (bytes in, bytes out — the DOM types' BufferSource writable side doesn't take a Uint8Array stream's chunks as one)
	const bytes = new Uint8Array(await new Response(gzipped.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer());
	const decoder = new TextDecoder();
	const field = (at: number, length: number): string => decoder.decode(bytes.subarray(at, at + length)).replace(/\0[\s\S]*$/u, "");
	const texts = new Map<string, string>();
	let longName: string | undefined;

	for (let at = 0; at + 512 <= bytes.length;) {
		const name = field(at, 100);

		if (name === "") {
			break; // the two empty blocks that end it
		}

		const size = Number.parseInt(field(at + 124, 12).trim() || "0", 8);
		const type = field(at + 156, 1);
		const prefix = field(at + 345, 155);
		const body = bytes.subarray(at + 512, at + 512 + size);
		const path = longName ?? (prefix === "" ? name : `${prefix}/${name}`);

		longName = undefined;

		if (type === "x") {
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(decoder.decode(body))?.[1];
		} else if (type === "L") {
			longName = decoder.decode(body).replace(/\0[\s\S]*$/u, "");
		} else if ((type === "0" || type === "") && wanted(path)) {
			texts.set(path, decoder.decode(body));
		}

		at += 512 + Math.ceil(size / 512) * 512;
	}

	return texts;
}

/** What `name`@`version`'s own code can do: detect over each of its tarball's code files. */
async function capsOf(name: string, version: string, tarball?: string): Promise<string[]> {
	const url = tarball ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
	const response = await fetch(url);

	if (!response.ok || response.body === null) {
		throw new Error(`${name}@${version}: ${response.status} from ${url}`);
	}

	const caps = new Set<string>();

	for (const text of (await tarballTexts(response.body)).values()) {
		for (const cap of detect(text)) {
			caps.add(cap);
		}
	}

	return [...caps].toSorted();
}

/** A dependency range the registry can resolve (not a file:, link:, git or URL dependency, nor an npm: alias). */
const resolvable = (range: string): boolean => !/^(?:file|link|workspace|git|git\+[a-z]+|https?|npm):|\//u.test(range);

/** `name`@`range` as the preview resolves it (esm.sh redirects a range to the exact version): its version, and its own
 *  dependencies. */
async function resolve(name: string, range: string): Promise<{ "version": string; "dependencies": Record<string, string> } | undefined> {
	const response = await fetch(`https://esm.sh/${name}@${encodeURIComponent(range)}/package.json`);

	if (!response.ok) {
		return undefined;
	}

	const manifest = await response.json() as { "version"?: string; "dependencies"?: Record<string, string> };
	const dependencies: Record<string, string> = manifest.dependencies ?? {};

	return manifest.version === undefined ? undefined : { "version": manifest.version, "dependencies": dependencies };
}

/** The packages a lockfile installs (npm's v2/v3 `packages`), each name once — the first, root before nested. */
export function lockedPackages(lock: { "packages"?: Record<string, { "version"?: string; "resolved"?: string; "link"?: boolean }> }): Wanted[] {
	const wanted = new Map<string, Wanted>();

	for (const [path, entry] of Object.entries(lock.packages ?? {}).toSorted(([one], [other]) => one.split("node_modules/").length - other.split("node_modules/").length)) {
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

		if (path !== "" && path.includes("node_modules/") && entry.version !== undefined && entry.link !== true && !wanted.has(name)) {
			wanted.set(name, { "name": name, "version": entry.version, ...entry.resolved?.startsWith("https://") === true ? { "tarball": entry.resolved } : {} });
		}
	}

	return [...wanted.values()];
}

/** Every package the project's package.jsons depend on, and theirs, resolved — each name once, the first found. */
async function resolvedPackages(manifests: { "dependencies"?: Record<string, string>; "devDependencies"?: Record<string, string> }[]): Promise<Wanted[]> {
	const wanted = new Map<string, Wanted>();
	const queue: [string, string][] = manifests.flatMap((manifest) => Object.entries({ ...manifest.devDependencies, ...manifest.dependencies }));

	while (queue.length > 0) {
		const batch = queue.splice(0, PARALLEL * 4).filter(([name, range], index, all) => !wanted.has(name) && resolvable(range) && all.findIndex(([other]) => other === name) === index);

		for (const [index, found] of (await Promise.all(batch.map(async ([name, range]) => resolve(name, range).catch(() => undefined)))).entries()) {
			const [name] = batch[index];

			if (found !== undefined && !wanted.has(name)) {
				wanted.set(name, { "name": name, "version": found.version });
				queue.push(...Object.entries<string>(found.dependencies));
			}
		}
	}

	return [...wanted.values()];
}

/** One sync at a time; one asked for while one runs is run after it (what changed meanwhile is then seen). */
let syncing: Promise<void> = Promise.resolve();
let queued = false;

/** What `.silo/baseline.json` holds: what was accepted, and how a package that can do more waits for acceptance. */
interface BaselineFile { "consumer"?: unknown; "packages"?: AcceptedPackages }

/**
 * `.silo/baseline.json` (at `root`) made if there's none, else brought up to what the project would install now (lib's
 * syncPackages): a library added is accepted as its code is; a new version that can do more is pending until it's
 * accepted, its new capabilities asking at the call meanwhile. What a package can do is read from its tarball only when
 * it's new or its version is — what's accepted, or pending, of the version installed is known. Runs never change it.
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

		const accepted = existing?.packages ?? {};
		const files = (await vscode.workspace.findFiles("**/package.json", `{**/node_modules/**,**/${SILO_DIR}/**}`)).toSorted((one, other) => one.path.length - other.path.length);
		const manifests = (await Promise.all(files.map(async (file) => read(file).catch(() => undefined)))).filter((manifest) => manifest !== undefined) as { "dependencies"?: Record<string, string>; "devDependencies"?: Record<string, string> }[];
		const lock = await read(vscode.Uri.file(`${root}/package-lock.json`)).catch(() => undefined) as Parameters<typeof lockedPackages>[0] | undefined;
		const wanted = lock?.packages === undefined ? await resolvedPackages(manifests) : lockedPackages(lock);
		const installed: Record<string, Accepted> = {};
		const unread: string[] = [];

		for (let at = 0; at < wanted.length; at += PARALLEL) {
			await Promise.all(wanted.slice(at, at + PARALLEL).map(async ({ name, version, tarball }) => {
				const known = accepted[name];
				const caps = known?.version === version ? known.caps : known?.pending?.version === version ? known.pending.caps : undefined;

				try {
					installed[name] = { "version": version, "caps": caps ?? await capsOf(name, version, tarball) };
				} catch (error) {
					unread.push(`${name}@${version} (${error instanceof Error ? error.message : String(error)})`);
				}
			}));
		}

		const { packages, changed } = syncPackages(accepted, installed);

		if (existing !== undefined && changed.added.length + changed.updated.length + changed.pending.length === 0) {
			return;
		}

		// (written as silo's saveBaseline writes it; `consumer` — the project's own imports — is desktop silo's to make)
		const sorted = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));

		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ "consumer": existing?.consumer ?? {}, "packages": sorted }, undefined, 2) + "\n"));

		if (existing === undefined) {
			console.info(`[baseline] made ${baselinePath()}: ${Object.keys(sorted).length} packages, from ${lock?.packages === undefined ? "package.json ranges (esm.sh)" : "package-lock.json"}`);
		} else {
			console.info(`[baseline] synced ${baselinePath()} — added: ${changed.added.join(", ") || "none"}; updated: ${changed.updated.join(", ") || "none"}; pending acceptance: ${changed.pending.join(", ") || "none"}`);
		}

		if (unread.length > 0) {
			console.warn(`[baseline] left out what couldn't be read — a run's calls by these will read as packages the baseline doesn't have: ${unread.join(", ")}`);
		}
	}).catch((error: unknown) => {
		console.error("[baseline] couldn't be synced:", error);
	});

	return syncing;
}

/** Keep `.silo/baseline.json` up to the project's dependencies: synced as a package.json or package-lock.json changes
 *  (one that's there — the first run that keeps evidence makes it). */
export function watchBaseline(vscode: typeof vscodeApi): vscodeApi.Disposable {
	const watcher = vscode.workspace.createFileSystemWatcher("**/{package.json,package-lock.json}");
	const changed = (uri: vscodeApi.Uri): void => {
		if (!uri.path.includes("/node_modules/")) {
			void syncBaseline(vscode, false);
		}
	};

	const listeners = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];

	return { "dispose": () => {
		for (const listener of [...listeners, watcher]) {
			listener.dispose();
		}
	} };
}
