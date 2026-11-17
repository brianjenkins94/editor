/**
 * Packages nothing in the workspace's node_modules has: fetched by the editor at the version it pins, installed in this
 * worker's own memory, and dropped when the pin changes.
 */
import { unpack } from "@brianjenkins94/almostnode/packages";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import { tally } from "./gate";
import { post, state, workerLog } from "./state";

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

/** The pinned versions as they are now, through the editor's runtime (the debugger's own read): each package's by its
 *  name, and one nested under the package that asked by its path there (`isomorphic-git/node_modules/ignore`). */
export function readPins(): Record<string, string> {
	try {
		const { packages } = JSON.parse(keptText("versions.json")) as { "packages"?: Record<string, { "version": string; "nested"?: Record<string, string> }> };

		return Object.fromEntries(Object.entries(packages ?? {}).flatMap(([name, { version, nested }]) => [[name, version], ...Object.entries(nested ?? {}).map(([inner, at]) => [`${name}/node_modules/${inner}`, at])]));
	} catch {
		return {};
	}
}

/** The path a pin's package is installed at (its name, or a nested one's path), and the package it is. */
const packageOf = (pin: string): string => pin.slice(pin.lastIndexOf("/node_modules/") + 1).replace(/^node_modules\//u, "");

/**
 * A package nothing in node_modules has (almostnode's `install`): its tarball, at the version the editor pins, unpacked
 * into this worker's memory — the run waits on the fetch. A package the policy bans is never fetched: its load fails as
 * a banned package's does (onPackage). False when nothing pins it (it's no dependency).
 */
export function installPackage(name: string): boolean {
	if (!unpackPin(name)) {
		return false;
	}

	// (and what it depends on at a version of its own, in its own node_modules: found there before the one kept by name)
	for (const pin of Object.keys(state.pins).filter((each) => each.startsWith(`${name}/node_modules/`) && !each.slice(name.length + "/node_modules/".length).includes("/node_modules/"))) {
		unpackPin(pin);
	}

	return true;
}

/** `pin` (a package's name, or a nested one's path) unpacked at its pinned version where it goes in this worker's memory. */
function unpackPin(pin: string): boolean {
	const version = state.pins[pin];
	const name = packageOf(pin);

	if (version === undefined || state.editorLink === undefined || state.runtime === undefined) {
		return false;
	}

	const dir = `${MEMORY_MODULES}/${pin}`;

	if (state.policy !== undefined && packageDisposition(state.policy, { "name": name, "version": version }) === "deny") {
		tally("load", `${name}@${version}`, "denied", `${name}@${version}`, "policy");

		throw Object.assign(new Error(`EACCES: ${name}@${version} may not run — the policy bans it`), { "code": "EACCES" });
	}

	const vfs = state.runtime.getVFS();
	const link = state.editorLink;

	// (under the run that required it: its span, as almostnode's install hook hands nothing down)
	return (state.runSpan ?? workerLog()).span("editor.extensions.tsval.worker.install.fetch", { "name": name, "version": version }, (span) => {
		// (installing is busy too: the worker blocks on each tarball, with nothing else to say — a run's dozen installs, a
		// minute and more with nothing told, read as stuck)
		post({ "type": "busy" });

		const archive = link.tarball(name, version);
		let files = 0;

		post({ "type": "busy" });

		for (const [path, bytes] of unpack(archive)) {
			const file = `${dir}/${path}`;

			vfs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { "recursive": true });
			vfs.writeFileSync(file, bytes);
			files += 1;
		}

		installed.set(pin, version);
		span.end({ "bytes": archive.byteLength, "count": files });

		return true;
	});
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

	for (const [pin, version] of installed) {
		// (one nested under a package removed went with it)
		if (state.pins[pin] !== version && vfs?.existsSync(`${MEMORY_MODULES}/${pin}`) === true) {
			remove(`${MEMORY_MODULES}/${pin}`);
		}

		if (state.pins[pin] !== version) {
			installed.delete(pin);
		}
	}
}
