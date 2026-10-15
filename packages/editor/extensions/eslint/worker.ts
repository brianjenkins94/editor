/**
 * ESLint's worker — the eslint extension's (extension.ts starts it through a classic bootstrap, as an extension's workers
 * start). Real ESLint, run under almostnode as Node would run it: its files are the toolchain the build traced and packed
 * (build/eslint-toolchain.ts → `eslint-toolchain.tgz`, served beside this worker), unpacked into this worker's memory at
 * /node_modules — the folder Node looks in last, above the workspace — laid out as npm lays out node_modules; the
 * workspace is the editor's, through the workspace runtime (its files as the editor has them — an open editor's unsaved
 * text included), read as tooling reads: never asked about, never counted. typescript-eslint's project service reads the
 * workspace's tsconfig and the files it imports, so the type-aware rules have their types.
 *
 * The config is the workspace's own `eslint.config.*`, as ESLint finds it — the repository's code, run here: its
 * imports resolve as Node resolves them, the toolchain standing in for the workspace's installs of the packages it has
 * (the workspace's copies of those aren't seen: the toolchain's are the ones known to run here — a workspace's TypeScript
 * 7, say, typescript-eslint can't use), the workspace's node_modules for the rest. Without one, or when it fails to
 * load, the preset (`@brianjenkins94/util/eslint`) — and the failure is said. What runs here can't reach out: once the
 * toolchain is fetched, the worker's network is shut (lockNetwork), and the workspace is read-only.
 *
 * Asked over its own channel (plain postMessage, as tsval's adapter and worker talk): it says `{ ready }` once it
 * listens; given `{ runtime: port }` (the extension's `workspaceRuntime().connect("eslint")`), it loads — then
 * `{ booted, ms, config }` (`config`: the file it lints with, or undefined for the preset, and `error` when the
 * workspace's failed to load), or `{ failed }` — and answers `{ id, lint: { file, text } }` with `{ id, messages }` and
 * `{ id, fix: { file, text } }` with `{ id, output, fixed }`, or `{ id, error }`. Requests sent before it booted wait.
 */
import type { RuntimeFs } from "@brianjenkins94/editor-api/runtime";
import { createRuntime } from "@brianjenkins94/almostnode";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { connectRuntime } from "@brianjenkins94/editor-api/runtime";
import { RuntimeVfs } from "../../shared/runtime-vfs";

/** What a lint says of a file: eslint's messages, as LintMessage has them (what the extension shows). */
interface Message { "line": number; "column": number; "endLine"?: number; "endColumn"?: number; "message": string; "ruleId": string | null; "severity": number; "fixable": boolean }

/** What runs ESLint, once loaded: lint a text, or fix it. */
interface Linter { "lint": (text: string, file: string) => Promise<Message[]>; "fix": (text: string, file: string) => Promise<{ "output": string; "fixed": boolean }> }

/** The module ESLint is loaded from: at the root, beside the toolchain's node_modules. */
const ENTRY = "/eslint-entry.js";
/** The names ESLint looks for a config by, in its order, at the workspace's root. */
const CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"];

/** The package a path is in, if it's under a node_modules folder: the name after the first one (`@scope/name` too). */
function packageOf(path: string): string | undefined {
	const [, after] = path.split("/node_modules/", 2);

	if (after === undefined) {
		return undefined;
	}

	const [first, second] = after.split("/");

	return first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;
}

/** The workspace's files, read as tooling reads them — the loader's own (`load`), never the editor's to decide or count —
 *  and never written: ESLint only reads, and its fixes come back as text. The workspace's installs of the toolchain's
 *  packages (`shadowed`) aren't there, so resolution goes on to the toolchain's, at /node_modules. */
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

			return files.readFile(path, { "load": true });
		},
		"stat": (path) => (hidden(path) ? undefined : files.stat(path, { "load": true })),
		"readdir": (path) => files.readdir(path, { "load": true }).filter((name) => !hidden(`${path}/${name}`)),
		"writeFile": refuse,
		"mkdir": refuse,
		"rm": refuse,
		"rename": refuse
	};
}

/** Shut this worker's ways out — every network global and every way to start another context, as code we only evaluate
 *  gets (editor-api/gated-eval) — for what runs here from now on: the repository's config and its plugins. */
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

/** What ESLint lints with: the workspace's config, or the preset (`config` undefined) — and why not the workspace's. */
interface Loaded { "linter": Linter; "config"?: string; "error"?: string }

/** ESLint, loaded under almostnode, over the workspace `files`, with the workspace's config or else the preset. */
async function load(files: RuntimeFs): Promise<Loaded> {
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

	const config = CONFIGS.map((name) => "/workspace/" + name).find((path) => files.stat(path, { "load": true })?.type === "file");
	// (same-origin: the code is the toolchain the build packed and the workspace's config; `cwd` is the workspace, which
	// the preset reads its tsconfig against as it's imported; packages resolved as Node resolves them — the toolchain is
	// what Node loaded; the config imported from this runtime's files, as Node imports it, TypeScript included)
	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "cwd": "/workspace", "browserField": false, "nativeFileImports": false });
	const loaded = await runtime.execute(`
module.exports = async (config) => {
	const { ESLint } = require("eslint");
	const messages = (result) => result.messages.map((message) => ({ "line": message.line, "column": message.column, "endLine": message.endLine, "endColumn": message.endColumn, "message": message.message, "ruleId": message.ruleId, "severity": message.severity, "fixable": message.fix !== undefined }));
	const linterOf = async (options) => {
		const linting = new ESLint(options);
		const fixing = new ESLint({ ...options, "fix": true });

		// (the config is loaded now, so a config that can't be is known before anything is linted)
		await linting.calculateConfigForFile("/workspace/index.ts");

		return {
			"lint": async (text, file) => messages((await linting.lintText(text, { "filePath": file, "warnIgnored": false }))[0] ?? { "messages": [] }),
			"fix": async (text, file) => {
				const [result] = await fixing.lintText(text, { "filePath": file, "warnIgnored": false });

				return { "output": result?.output ?? text, "fixed": result?.output !== undefined && result.output !== text };
			}
		};
	};
	const preset = async () => linterOf({ "cwd": "/workspace", "overrideConfigFile": true, "overrideConfig": (await import("@brianjenkins94/util/eslint")).default });

	if (config === undefined) {
		return { "linter": await preset() };
	}

	try {
		return { "linter": await linterOf({ "cwd": "/workspace", "overrideConfigFile": config, "flags": ["unstable_native_nodejs_ts_config"] }), "config": config };
	} catch (error) {
		return { "linter": await preset(), "error": error instanceof Error ? error.message : String(error) };
	}
};
`, ENTRY);

	return await (loaded.exports as (config: string | undefined) => Promise<Loaded>)(config);
}

/** ESLint once it's loaded — what every request waits on, a request sent before the runtime's port arrived included. */
let loaded: (linter: Promise<Linter>) => void;
const linter = new Promise<Linter>((resolve) => {
	loaded = resolve;
});

globalThis.addEventListener("message", (event: MessageEvent) => {
	const data = event.data as { "runtime"?: MessagePort; "id"?: number; "lint"?: { "file": string; "text": string }; "fix"?: { "file": string; "text": string } };

	if (data.runtime !== undefined) {
		const link = connectRuntime(data.runtime, { "name": "eslint" });
		const started = performance.now();

		const loading = link.ready.then(() => load(link.fs));

		loaded(loading.then((done) => done.linter));
		loading.then((done) => {
			globalThis.postMessage({ "booted": true, "ms": Math.round(performance.now() - started), "config": done.config, "error": done.error });
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
				globalThis.postMessage({ "id": id, "messages": await running.lint(data.lint.text, data.lint.file) });
			} else if (data.fix !== undefined) {
				globalThis.postMessage({ "id": id, ...await running.fix(data.fix.text, data.fix.file) });
			}
		} catch (error) {
			globalThis.postMessage({ "id": id, "error": error instanceof Error ? error.message : String(error) });
		}
	})();
});

globalThis.postMessage({ "ready": true });
