/**
 * A package installed into the workspace's node_modules, as a run needs it — a debug run's `require` finds nothing (the
 * editor serves packages from a CDN, and type acquisition writes only their types) and asks for it to be installed
 * (run-contract's `install`, through the bridge), then resolves it again. The version is the shared resolver's
 * (versions.ts), the same one the baseline read and the preview loads; its files are its published tarball's.
 *
 * What's installed is kept in `node_modules/.package-lock.json`, as npm keeps it (its hidden lockfile), so a package
 * whose pinned version changes is installed again at it (refreshInstalled) rather than running the old one.
 *
 * Written straight into the workspace's zen-fs — what the workers read — not through VS Code's overlays: under them is
 * the read-only CDN node_modules (node-modules-provider.ts), and a path it has answered can't be written over (no
 * copy-up). Above it, the files written are what the editor sees too.
 */
import type * as vscodeApi from "vscode";
import { versionsPath } from "@brianjenkins94/util/silo/layout";
import { fs } from "@zenfs/core";
import { syncVersions, type VersionsFile } from "./versions";

/** npm's hidden lockfile (lockfile v3): what's installed, by its path under the workspace. */
interface HiddenLock { "name"?: string; "lockfileVersion": 3; "requires": true; "packages": Record<string, { "version": string; "resolved": string }> }

/** A .tgz's files, by path within the package (its tar entries' first folder — `package/` — dropped): gunzipped, then
 *  read as ustar, with pax and GNU long names. `wanted` picks which. */
export async function tarballFiles(gzipped: ReadableStream<Uint8Array>, wanted: (path: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
	// (bytes in, bytes out — the DOM types' BufferSource writable side doesn't take a Uint8Array stream's chunks as one)
	const bytes = new Uint8Array(await new Response(gzipped.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer());
	const decoder = new TextDecoder();
	const field = (at: number, length: number): string => decoder.decode(bytes.subarray(at, at + length)).replace(/\0[\s\S]*$/u, "");
	const files = new Map<string, Uint8Array>();
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
		const path = (longName ?? (prefix === "" ? name : `${prefix}/${name}`)).replace(/^[^/]*\//u, "");

		longName = undefined;

		if (type === "x") {
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(decoder.decode(body))?.[1];
		} else if (type === "L") {
			longName = decoder.decode(body).replace(/\0[\s\S]*$/u, "");
		} else if ((type === "0" || type === "") && path !== "" && wanted(path)) {
			files.set(path, body.slice());
		}

		at += 512 + Math.ceil(size / 512) * 512;
	}

	return files;
}

/** `name`@`version`'s published tarball (a lockfile's `resolved` URL, else npm's registry's), its files read. */
export async function packageFiles(name: string, version: string, tarball?: string, wanted?: (path: string) => boolean): Promise<Map<string, Uint8Array>> {
	const url = tarball ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
	const response = await fetch(url);

	if (!response.ok || response.body === null) {
		throw new Error(`${name}@${version}: ${response.status} from ${url}`);
	}

	return tarballFiles(response.body, wanted);
}

/** One install at a time: the debug run asking is waiting on it, and the hidden lockfile is written by each. */
let installing: Promise<unknown> = Promise.resolve();

/**
 * `name` installed into `root`'s node_modules at the version the editor pins (.silo/versions.json) — its tarball's files
 * written, over what type acquisition put there — unless it's installed at that version already. Its version; undefined
 * when nothing pins one (it's no dependency of the project's, nor of theirs).
 */
export function installPackage(vscode: typeof vscodeApi, name: string, root = "/workspace"): Promise<string | undefined> {
	const done = installing.then(async () => {
		const read = async (file: vscodeApi.Uri): Promise<unknown> => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as unknown;
		// (the pinned versions as they are — resolved again only when they don't name it: a dependency just added)
		const versions = await read(vscode.Uri.file(`${root}/${versionsPath()}`)).catch(() => undefined) as VersionsFile | undefined;
		const pinned = versions?.packages[name] ?? (await syncVersions(vscode, root))?.packages[name];

		if (pinned === undefined) {
			return undefined;
		}

		const lock = installedIn(root) ?? { "lockfileVersion": 3, "requires": true, "packages": {} };
		const key = `node_modules/${name}`;
		const dir = `${root}/${key}`;

		if (lock.packages[key]?.version === pinned.version) {
			return pinned.version;
		}

		const files = await packageFiles(name, pinned.version, pinned.tarball);

		// (another version's files gone first, so none of them is left to load)
		if (lock.packages[key] !== undefined) {
			fs.rmSync(dir, { "recursive": true, "force": true });
		}

		for (const [path, bytes] of files) {
			fs.mkdirSync(`${dir}/${path}`.slice(0, `${dir}/${path}`.lastIndexOf("/")), { "recursive": true });
			fs.writeFileSync(`${dir}/${path}`, bytes);
		}

		lock.packages[key] = { "version": pinned.version, "resolved": pinned.tarball ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${pinned.version}.tgz` };
		lock.packages = Object.fromEntries(Object.entries(lock.packages).toSorted(([one], [other]) => one.localeCompare(other)));
		fs.writeFileSync(`${root}/node_modules/.package-lock.json`, JSON.stringify(lock, undefined, 2) + "\n");
		console.info(`[install] ${name}@${pinned.version}: ${files.size} files`);

		return pinned.version;
	});

	installing = done.catch(() => undefined);

	return done;
}

/** What's installed in `root`'s node_modules (its hidden lockfile), if anything is. */
function installedIn(root: string): HiddenLock | undefined {
	try {
		return JSON.parse(fs.readFileSync(`${root}/node_modules/.package-lock.json`, "utf8")) as HiddenLock;
	} catch {
		return undefined;
	}
}

/** Each installed package whose pinned version has changed, installed again at it. */
export async function refreshInstalled(vscode: typeof vscodeApi, versions: VersionsFile | undefined, root = "/workspace"): Promise<void> {
	for (const [key, { version }] of Object.entries<{ "version": string }>(installedIn(root)?.packages ?? {})) {
		const name = key.slice("node_modules/".length);
		const pinned = versions?.packages[name]?.version;

		if (pinned !== undefined && pinned !== version) {
			await installPackage(vscode, name, root).catch((error: unknown) => {
				console.warn(`[install] ${name}@${pinned} couldn't be installed:`, error);
			});
		}
	}
}
