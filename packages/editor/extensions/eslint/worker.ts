/**
 * ESLint's worker — the eslint extension's (extension.ts starts it through a classic bootstrap, as an extension's workers
 * start). Real ESLint, run under almostnode as Node would run it: its files are the toolchain the build traced and packed
 * (build/eslint-toolchain.ts → `eslint-toolchain.tgz`, served beside this worker), unpacked into this worker's memory at
 * /node_modules — the folder Node looks in last, above the workspace — laid out as npm lays out node_modules; the
 * workspace is the editor's, through the workspace runtime (its files as the editor has them — an open editor's unsaved
 * text included), read as tooling reads: never asked about, never counted. typescript-eslint's project service reads the
 * workspace's tsconfig and the files it imports, so the type-aware rules have their types.
 *
 * The config is the workspace's own, as ESLint finds it for each file — the nearest `eslint.config.*` above it, so a
 * package's own in a monorepo — from the working directory the extension gives (`eslint.workingDirectories`, as the
 * desktop extension reads it). It's the repository's code, run here: its imports resolve as Node resolves them, the toolchain standing in for the workspace's installs of the packages it has
 * (the workspace's copies of those aren't seen: the toolchain's are the ones known to run here — a workspace's TypeScript
 * 7, say, typescript-eslint can't use), the workspace's node_modules for the rest. A file with none above it, or whose
 * config fails to load, gets the preset (`@brianjenkins94/util/eslint`) — and the failure is said. What runs here can't reach out: once the
 * toolchain is fetched, the worker's network is shut (lockNetwork), and the workspace is read-only.
 *
 * Asked over its own channel (plain postMessage, as tsval's adapter and worker talk): it says `{ ready }` once it
 * listens; given `{ runtime: port }` (the extension's `workspaceRuntime().connect("eslint")`), it loads — then
 * `{ booted, ms }`, or `{ failed }` — and answers `{ id, lint: { file, text, cwd } }` with `{ id, messages }` and
 * `{ id, fix: { file, text, cwd } }` with `{ id, output, fixed }`, each with `config` (the file's config, or none for
 * the preset) and `error` (why its config didn't load) — or `{ id, error }`. Requests sent before it booted wait.
 */
import type { RuntimeFs } from "@brianjenkins94/editor-api/runtime";
import { createRuntime } from "@brianjenkins94/almostnode";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { connectRuntime } from "@brianjenkins94/editor-api/runtime";
import { RuntimeVfs } from "@brianjenkins94/editor-api/runtime-vfs";

/** What a lint says of a file: eslint's messages, as LintMessage has them (what the extension shows). */
interface Message { "line": number; "column": number; "endLine"?: number; "endColumn"?: number; "message": string; "ruleId": string | null; "severity": number; "fixable": boolean }

/** Which config linted a file: its path (none: the preset), and why it isn't the file's own when that failed to load. */
interface Using { "config"?: string; "error"?: string }

/** What runs ESLint, once loaded: lint a text, or fix it, as `file` from the working directory `cwd`. */
interface Linter { "lint": (text: string, file: string, cwd: string) => Promise<Using & { "messages": Message[] }>; "fix": (text: string, file: string, cwd: string) => Promise<Using & { "output": string; "fixed": boolean }> }

/** The module ESLint is loaded from: at the root, beside the toolchain's node_modules. */
const ENTRY = "/eslint-entry.js";

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

/** ESLint, loaded under almostnode, over the workspace `files`: each file with its own config, or else the preset. */
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

	// (same-origin: the code is the toolchain the build packed and the workspace's configs; `cwd` is the workspace, which
	// the preset reads its tsconfig against as it's imported; packages resolved as Node resolves them — the toolchain is
	// what Node loaded; a config imported from this runtime's files, as Node imports it, TypeScript included)
	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "cwd": "/workspace", "browserField": false, "nativeFileImports": false });
	const loaded = await runtime.execute(`
module.exports = async () => {
	const { ESLint } = require("eslint");
	const messages = (result) => result.messages.map((message) => ({ "line": message.line, "column": message.column, "endLine": message.endLine, "endColumn": message.endColumn, "message": message.message, "ruleId": message.ruleId, "severity": message.severity, "fixable": message.fix !== undefined }));
	const pair = (options) => ({ "linting": new ESLint(options), "fixing": new ESLint({ ...options, "fix": true }) });
	// (one ESLint a working directory, each finding a file's config above it as ESLint 10 does — and caching what it loads)
	const byCwd = new Map();
	const at = (cwd) => {
		if (!byCwd.has(cwd)) {
			byCwd.set(cwd, pair({ "cwd": cwd, "flags": ["unstable_native_nodejs_ts_config"] }));
		}

		return byCwd.get(cwd);
	};
	let preset;
	const presetPair = async () => (preset ??= pair({ "cwd": "/workspace", "overrideConfigFile": true, "overrideConfig": (await import("@brianjenkins94/util/eslint")).default }));
	// (the file's config, loaded now so one that can't be is known before anything is linted with it)
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

	// (what the workspace's root lints with, loaded now — its config, or the preset — so the first file waits on less)
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

/** ESLint once it's loaded — what every request waits on, a request sent before the runtime's port arrived included. */
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
