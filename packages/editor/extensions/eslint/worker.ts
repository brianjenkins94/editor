import type { RuntimeFs } from "@brianjenkins94/editor-api/runtime";
import { createRuntime } from "@brianjenkins94/almostnode";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { connectRuntime } from "@brianjenkins94/editor-api/runtime";
import { RuntimeVfs } from "@brianjenkins94/editor-api/runtime-vfs";

interface Message { "line"?: number; "column"?: number; "endLine"?: number; "endColumn"?: number; "message": string; "ruleId": string | null; "severity": number; "fixable": boolean }

interface Using { "config"?: string; "error"?: string }

interface Linter { "lint": (text: string, file: string, cwd: string) => Promise<Using & { "messages": Message[] }>; "fix": (text: string, file: string, cwd: string) => Promise<Using & { "output": string; "fixed": boolean }> }

const ENTRY = "/eslint-entry.js";

function packageOf(path: string): string | undefined {
	const [, after] = path.split("/node_modules/", 2);

	if (after === undefined) {
		return undefined;
	}

	const [first, second] = after.split("/");

	return first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;
}

const ROOT_TSCONFIG = "/workspace/tsconfig.json";
const STAND_IN_TSCONFIG = new TextEncoder().encode("{}\n");

function readOnly(files: RuntimeFs, shadowed: Set<string>): RuntimeFs {
	const refuse = (path: string): never => {
		throw Object.assign(new Error(`EROFS: eslint's worker doesn't write the workspace, '${path}'`), { "code": "EROFS" });
	};

	const hidden = (path: string): boolean => {
		const name = packageOf(path);

		return name !== undefined && shadowed.has(name);
	};

	return {
		"readFile": (path) => {
			if (hidden(path)) {
				throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { "code": "ENOENT" });
			}

			if (path === ROOT_TSCONFIG && files.stat(path, { "load": true }) === undefined) {
				return STAND_IN_TSCONFIG;
			}

			return files.readFile(path, { "load": true });
		},
		"stat": (path) => {
			if (hidden(path)) {
				return undefined;
			}

			return files.stat(path, { "load": true }) ?? (path === ROOT_TSCONFIG ? { "type": "file", "size": STAND_IN_TSCONFIG.length, "mtime": 0 } : undefined);
		},
		"readdir": (path) => files.readdir(path, { "load": true }).filter((name) => !hidden(`${path}/${name}`)),
		"writeFile": refuse,
		"mkdir": refuse,
		"rm": refuse,
		"rename": refuse
	};
}

function lockNetwork(): void {
	const scope = globalThis as unknown as Record<string, unknown>;

	for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "SharedWorker", "BroadcastChannel"]) {
		const shut = (): never => {
			throw new Error(`eslint's worker has no network: ${name} is shut once its toolchain is loaded`);
		};

		Object.defineProperty(scope, name, { "configurable": false, "writable": false, "value": shut });
	}

	if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
		Object.defineProperty(navigator, "sendBeacon", { "configurable": false, "value": () => false });
	}
}

async function load(files: RuntimeFs): Promise<Linter> {
	const archive = await fetch(new URL("./eslint-toolchain.tgz", import.meta.url));

	if (!archive.ok) {
		throw new Error(`the toolchain: ${archive.status} from ${archive.url}`);
	}

	const toolchain = unpack(new Uint8Array(await archive.arrayBuffer()));

	lockNetwork();

	const shadowed = new Set([...toolchain.keys()].map((path) => packageOf("/" + path)).filter((name) => name !== undefined));
	const vfs = new RuntimeVfs(readOnly(files, shadowed));

	for (const [path, bytes] of toolchain) {
		const file = "/" + path;

		vfs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { "recursive": true });
		vfs.writeFileSync(file, bytes);
	}

	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "cwd": "/workspace", "browserField": false, "nativeFileImports": false });
	const loaded = await runtime.execute(`
module.exports = async () => {
	const { ESLint } = require("eslint");
	const messages = (result) => result.messages.map((message) => ({ "line": message.line, "column": message.column, "endLine": message.endLine, "endColumn": message.endColumn, "message": message.message, "ruleId": message.ruleId, "severity": message.severity, "fixable": message.fix !== undefined }));
	const pair = (options) => ({ "linting": new ESLint(options), "fixing": new ESLint({ ...options, "fix": true }) });
	const byCwd = new Map();
	const at = (cwd) => {
		if (!byCwd.has(cwd)) {
			byCwd.set(cwd, pair({ "cwd": cwd, "flags": ["unstable_native_nodejs_ts_config"] }));
		}

		return byCwd.get(cwd);
	};
	let preset;
	const presetPair = async () => (preset ??= pair({ "cwd": "/workspace", "overrideConfigFile": true, "overrideConfig": (await import("@brianjenkins94/util/eslint")).default }));
	const using = async (file, cwd) => {
		const own = at(cwd);
		const config = await own.linting.findConfigFile(file);

		if (config === undefined) {
			return { "eslint": await presetPair() };
		}

		try {
			await own.linting.calculateConfigForFile(file);

			return { "eslint": own, "config": config };
		} catch (error) {
			return { "eslint": await presetPair(), "config": config, "error": error instanceof Error ? error.message : String(error) };
		}
	};
	const told = ({ config, error }) => ({ ...config === undefined ? {} : { "config": config }, ...error === undefined ? {} : { "error": error } });

	await using("/workspace/index.ts", "/workspace");

	return {
		"lint": async (text, file, cwd) => {
			const use = await using(file, cwd);

			return { "messages": messages((await use.eslint.linting.lintText(text, { "filePath": file, "warnIgnored": false }))[0] ?? { "messages": [] }), ...told(use) };
		},
		"fix": async (text, file, cwd) => {
			const use = await using(file, cwd);
			const [result] = await use.eslint.fixing.lintText(text, { "filePath": file, "warnIgnored": false });

			return { "output": result?.output ?? text, "fixed": result?.output !== undefined && result.output !== text, ...told(use) };
		}
	};
};
`, ENTRY);

	return await (loaded.exports as () => Promise<Linter>)();
}

let loaded: (linter: Promise<Linter>) => void;
const linter = new Promise<Linter>((resolve) => {
	loaded = resolve;
});

globalThis.addEventListener("message", (event: MessageEvent) => {
	const data = event.data as { "runtime"?: MessagePort; "id"?: number; "lint"?: { "file": string; "text": string; "cwd": string }; "fix"?: { "file": string; "text": string; "cwd": string } };

	if (data.runtime !== undefined) {
		const link = connectRuntime(data.runtime, { "name": "eslint" });
		const started = performance.now();

		const loading = link.ready.then(() => load(link.fs));

		loaded(loading);
		loading.then(() => {
			globalThis.postMessage({ "booted": true, "ms": Math.round(performance.now() - started) });
		}, (error: unknown) => {
			globalThis.postMessage({ "failed": error instanceof Error ? error.stack ?? error.message : String(error) });
		});

		return;
	}

	const { id } = data;

	if (id === undefined) {
		return;
	}

	void (async () => {
		try {
			const running = await linter;

			if (data.lint !== undefined) {
				globalThis.postMessage({ "id": id, ...await running.lint(data.lint.text, data.lint.file, data.lint.cwd) });
			} else if (data.fix !== undefined) {
				globalThis.postMessage({ "id": id, ...await running.fix(data.fix.text, data.fix.file, data.fix.cwd) });
			}
		} catch (error) {
			globalThis.postMessage({ "id": id, "error": error instanceof Error ? error.message : String(error) });
		}
	})();
});

globalThis.postMessage({ "ready": true });
