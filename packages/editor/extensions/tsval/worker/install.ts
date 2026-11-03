/**
 * Packages nothing in the workspace's node_modules has: fetched by the editor at the version it pins, installed in this
 * worker's own memory, and dropped when the pin changes.
 */
import { unpack } from "@brianjenkins94/almostnode/packages";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import { tally } from "./gate";
import { post, state } from "./state";

/** A file the editor keeps for the project, as text: `.silo/<name>` when the repository has it, else its local copy
 *  (editor-api's git.ts `keptAt`) — through the editor's runtime, as the debugger's own read. */
export function keptText(name: string): string {
	try {
		return new TextDecoder().decode(state.editorLink?.fs.readFile(`/workspace/.silo/${name}`, { "load": true }));
	} catch {
		return new TextDecoder().decode(state.editorLink?.fs.readFile(`/workspace/.silo/local/${name}`, { "load": true }));
	}
}

/** Where a package nothing in the workspace's node_modules has is installed: this worker's own memory (its root, which
 *  almostnode looks in last) — the workspace's filesystem is a fixed-size shared buffer, too small for node_modules. */
const MEMORY_MODULES = "/node_modules";

/** What's installed there, by name: its version. */
const installed = new Map<string, string>();

/** The pinned versions as they are now, through the editor's runtime (the debugger's own read). */
export function readPins(): Record<string, string> {
	try {
		const { packages } = JSON.parse(keptText("versions.json")) as { "packages"?: Record<string, { "version": string }> };

		return Object.fromEntries(Object.entries(packages ?? {}).map(([name, { version }]) => [name, version]));
	} catch {
		return {};
	}
}

/**
 * A package nothing in node_modules has (almostnode's `install`): its tarball, at the version the editor pins, unpacked
 * into this worker's memory — the run waits on the fetch. A package the policy bans is never fetched: its load fails as
 * a banned package's does (onPackage). False when nothing pins it (it's no dependency).
 */
export function installPackage(name: string): boolean {
	const version = state.pins[name];

	if (version === undefined || state.editorLink === undefined || state.runtime === undefined) {
		return false;
	}

	const dir = `${MEMORY_MODULES}/${name}`;

	if (state.policy !== undefined && packageDisposition(state.policy, { "name": name, "version": version }) === "deny") {
		tally("load", `${name}@${version}`, "denied", `${name}@${version}`, "policy");

		throw Object.assign(new Error(`EACCES: ${name}@${version} may not run — the policy bans it`), { "code": "EACCES" });
	}

	const vfs = state.runtime.getVFS();

	// (installing is busy too: the worker blocks on each tarball, with nothing else to say — a run's dozen installs, a
	// minute and more with nothing told, read as stuck)
	post({ "type": "busy" });

	const archive = state.editorLink.tarball(name, version);

	post({ "type": "busy" });

	for (const [path, bytes] of unpack(archive)) {
		const file = `${dir}/${path}`;

		vfs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { "recursive": true });
		vfs.writeFileSync(file, bytes);
	}

	installed.set(name, version);

	return true;
}

/** What's installed whose pin has changed since, removed — installed again, at its new version, as it's required. */
export function dropUnpinned(): void {
	const vfs = state.runtime?.getVFS();
	const remove = (path: string): void => {
		if (vfs?.statSync(path).isDirectory() === true) {
			for (const entry of vfs.readdirSync(path)) {
				remove(`${path}/${entry}`);
			}

			vfs.rmdirSync(path);
		} else {
			vfs?.unlinkSync(path);
		}
	};

	for (const [name, version] of installed) {
		if (state.pins[name] !== version) {
			remove(`${MEMORY_MODULES}/${name}`);
			installed.delete(name);
		}
	}
}
