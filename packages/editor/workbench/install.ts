/**
 * `npm install`, for the dependencies the CDN can't serve (versions.ts's `installsLocally`). A registry package loads
 * lazily, at the version versions.ts pins — the node_modules overlay for the editor, type acquisition for its types, a
 * runtime's own install for `require` — so only these are put in node_modules, as npm puts them:
 *
 * - A `file:` or `link:` dependency: a symlink to its folder. zen-fs follows it in every realm, so `node` resolves it
 *   too. The store doesn't keep symlinks, so each sync makes them again. TypeScript in the browser doesn't resolve them
 *   (its host's `realpath` only normalizes a path), so the capabilities tsserver plugin does, from `.silo/versions.json`:
 *   a linked file has one name, its folder's.
 * - A tarball anywhere but npm's registry (`https://…/util@latest.tgz`): fetched and unpacked into the store, like any
 *   file — its files are the package's types as well as its code. Once per version; a tarball whose version doesn't
 *   match what's pinned (a mutable `@latest`) is fetched once a session.
 *
 * Run by every sync of the versions (versions.ts), as the project opens and as a manifest changes.
 */
import type * as vscodeApi from "vscode";
import type { Resolved } from "./versions";
import { fs } from "@zenfs/core";
import { tarball } from "./tarballs";
import { installsLocally } from "./versions";

/** What a package.json says, of what installing reads. */
interface Manifest { "version"?: string; "dependencies"?: Record<string, string>; "peerDependencies"?: Record<string, string>; "optionalDependencies"?: Record<string, string> }

/** The tarballs unpacked this session, by where: the URL each came from. */
const unpackedFrom = new Map<string, string>();

function manifestAt(path: string): Manifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(path, "utf8")) as Manifest;
	} catch {
		return undefined;
	}
}

function lstat(path: string): ReturnType<typeof fs.lstatSync> | undefined {
	try {
		return fs.lstatSync(path);
	} catch {
		return undefined;
	}
}

/** Whatever is at `path` taken away: a symlink unlinked (never what it links to), anything else deleted through the
 *  store, so the deletion is kept. */
async function clear(vscode: typeof vscodeApi, path: string): Promise<void> {
	const at = lstat(path);

	if (at?.isSymbolicLink() === true) {
		fs.unlinkSync(path);
	} else if (at !== undefined) {
		await vscode.workspace.fs.delete(vscode.Uri.file(path), { "recursive": true, "useTrash": false });
	}
}

/** `path` a symlink to `target`; whether it had to be made. */
async function link(vscode: typeof vscodeApi, path: string, target: string): Promise<boolean> {
	if (lstat(path)?.isSymbolicLink() === true && String(fs.readlinkSync(path)) === target) {
		return false;
	}

	await clear(vscode, path);
	fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { "recursive": true });
	fs.symlinkSync(target, path);

	return true;
}

/** `name`'s tarball unpacked at `path`, unless it is already; whether it had to be. */
async function unpackAt(vscode: typeof vscodeApi, path: string, name: string, each: Resolved): Promise<boolean> {
	const url = each.tarball ?? "";
	const present = lstat(path)?.isSymbolicLink() === true ? undefined : manifestAt(`${path}/package.json`);

	if (present !== undefined && (present.version === each.version || unpackedFrom.get(path) === url)) {
		return false;
	}

	const { unpack } = await import("@brianjenkins94/almostnode/packages");
	const files = unpack(await tarball(name, each.version, url));

	await clear(vscode, path);
	await Promise.all([...files].map(async ([file, bytes]) => vscode.workspace.fs.writeFile(vscode.Uri.file(`${path}/${file}`), bytes)));
	unpackedFrom.set(path, url);

	return true;
}

/**
 * The packages in `packages` the CDN can't serve, installed in `root`'s node_modules. Returns each as installed (its
 * version and dependencies, from its package.json), the ranges the unpacked ones depend on (`wants`, to resolve in
 * turn: a linked one's are its manifest's, already read), and whether anything changed. One that can't be installed is
 * said, and left as it was.
 */
export async function install(vscode: typeof vscodeApi, root: string, packages: Record<string, Resolved>): Promise<{ "installed": Record<string, Resolved>; "wants": Record<string, string>; "changed": boolean }> {
	const installed: Record<string, Resolved> = {};
	const wants: Record<string, string> = {};
	let changed = false;

	await Promise.all(Object.entries(packages).filter(([, each]) => installsLocally(each)).map(async ([name, each]) => {
		const path = `${root}/node_modules/${name}`;

		try {
			if (each.link === undefined) {
				changed = await unpackAt(vscode, path, name, each) || changed;
			} else if (manifestAt(`${root}/${each.link}/package.json`) === undefined) {
				throw new Error(`${each.link} has no package.json`);
			} else {
				changed = await link(vscode, path, `${root}/${each.link}`) || changed;
			}

			const manifest = manifestAt(`${path}/package.json`) ?? {};
			const ranges = { ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies };

			installed[name] = { ...each, "version": manifest.version ?? each.version, "dependencies": Object.keys(ranges).toSorted() };

			if (each.link === undefined) {
				Object.assign(wants, ranges);
			}
		} catch (error) {
			console.warn(`[install] ${name} (${each.range}) couldn't be installed:`, error instanceof Error ? error.message : String(error));
		}
	}));

	return { "installed": installed, "wants": wants, "changed": changed };
}
