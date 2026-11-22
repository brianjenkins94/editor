import type * as vscodeApi from "vscode";
import type { Resolved } from "./versions";
import { fs as store } from "@zenfs/core";
import { callerFs } from "../shared/fs-caller";
import { tarball } from "./tarballs";
import { installsLocally } from "./versions";

const fs = callerFs(store, "install");

interface Manifest { "version"?: string; "dependencies"?: Record<string, string>; "peerDependencies"?: Record<string, string>; "optionalDependencies"?: Record<string, string> }

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

async function clear(vscode: typeof vscodeApi, path: string): Promise<void> {
	const at = lstat(path);

	if (at?.isSymbolicLink() === true) {
		fs.unlinkSync(path);
	} else if (at !== undefined) {
		await vscode.workspace.fs.delete(vscode.Uri.file(path), { "recursive": true, "useTrash": false });
	}
}

async function link(vscode: typeof vscodeApi, path: string, target: string): Promise<boolean> {
	if (lstat(path)?.isSymbolicLink() === true && String(fs.readlinkSync(path)) === target) {
		return false;
	}

	await clear(vscode, path);
	fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { "recursive": true });
	fs.symlinkSync(target, path);

	return true;
}

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
