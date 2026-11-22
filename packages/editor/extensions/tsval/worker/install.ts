import { unpack } from "@brianjenkins94/almostnode/packages";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import { tally } from "./gate";
import { post, state, workerLog } from "./state";

export function keptText(name: string): string {
	try {
		return new TextDecoder().decode(state.editorLink?.fs.readFile(`/workspace/.silo/${name}`, { "load": true }));
	} catch {
		return new TextDecoder().decode(state.editorLink?.fs.readFile(`/workspace/.silo/local/${name}`, { "load": true }));
	}
}

const MEMORY_MODULES = "/node_modules";

const installed = new Map<string, string>();

export function readPins(): Record<string, string> {
	try {
		const { packages } = JSON.parse(keptText("versions.json")) as { "packages"?: Record<string, { "version": string; "nested"?: Record<string, string> }> };

		return Object.fromEntries(Object.entries(packages ?? {}).flatMap(([name, { version, nested }]) => [[name, version], ...Object.entries(nested ?? {}).map(([inner, at]) => [`${name}/node_modules/${inner}`, at])]));
	} catch {
		return {};
	}
}

const packageOf = (pin: string): string => pin.slice(pin.lastIndexOf("/node_modules/") + 1).replace(/^node_modules\//u, "");

export function installPackage(name: string): boolean {
	if (!unpackPin(name)) {
		return false;
	}

	for (const pin of Object.keys(state.pins).filter((each) => each.startsWith(`${name}/node_modules/`) && !each.slice(name.length + "/node_modules/".length).includes("/node_modules/"))) {
		unpackPin(pin);
	}

	return true;
}

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

	return (state.runSpan ?? workerLog()).span("editor.extensions.tsval.worker.install.fetch", { "name": name, "version": version }, (span) => {
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
		if (state.pins[pin] !== version && vfs?.existsSync(`${MEMORY_MODULES}/${pin}`) === true) {
			remove(`${MEMORY_MODULES}/${pin}`);
		}

		if (state.pins[pin] !== version) {
			installed.delete(pin);
		}
	}
}
