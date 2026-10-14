/**
 * ESLint's worker — the eslint extension's (extension.ts starts it through a classic bootstrap, as an extension's workers
 * start). Real ESLint and the preset (`@brianjenkins94/util/eslint`), run under almostnode as Node would run them: their
 * files are the toolchain the build traced and packed (build/eslint-toolchain.ts → `eslint-toolchain.tgz`, served beside
 * this worker), unpacked into this worker's memory under /eslint, laid out as npm lays out node_modules; the workspace is
 * the editor's, through the workspace runtime (its files as the editor has them — an open editor's unsaved text
 * included), read as tooling reads: never asked about, never counted. typescript-eslint's project service reads the
 * workspace's tsconfig and the files it imports, so the type-aware rules have their types.
 *
 * Asked over its own channel (plain postMessage, as tsval's adapter and worker talk): it says `{ ready }` once it
 * listens; given `{ runtime: port }` (the extension's `workspaceRuntime().connect("eslint")`), it loads — then
 * `{ booted, ms }`, or `{ failed }` — and answers `{ id, lint: { file, text } }` with `{ id, messages }` and
 * `{ id, fix: { file, text } }` with `{ id, output, fixed }`, or `{ id, error }`. Requests sent before it booted wait.
 */
import type { RuntimeFs } from "@brianjenkins94/run-contract/runtime";
import { createRuntime } from "@brianjenkins94/almostnode";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { connectRuntime } from "@brianjenkins94/run-contract/runtime";
import { RuntimeVfs } from "../../shared/runtime-vfs";

/** What a lint says of a file: eslint's messages, as LintMessage has them (what the extension shows). */
interface Message { "line": number; "column": number; "endLine"?: number; "endColumn"?: number; "message": string; "ruleId": string | null; "severity": number; "fixable": boolean }

/** What runs ESLint, once loaded: lint a text, or fix it. */
interface Linter { "lint": (text: string, file: string) => Promise<Message[]>; "fix": (text: string, file: string) => Promise<{ "output": string; "fixed": boolean }> }

/** Where the toolchain is unpacked: its packages laid out as npm lays them out (`node_modules/…`). */
const TOOLCHAIN = "/eslint";
/** The module ESLint is loaded from: beside the toolchain's node_modules. */
const ENTRY = TOOLCHAIN + "/eslint-entry.js";

/** The workspace's files, read as tooling reads them — the loader's own (`load`), never the editor's to decide or count —
 *  and never written: ESLint only reads, and its fixes come back as text. */
function readOnly(files: RuntimeFs): RuntimeFs {
	const refuse = (path: string): never => {
		throw Object.assign(new Error(`EROFS: eslint's worker doesn't write the workspace, '${path}'`), { "code": "EROFS" });
	};

	return {
		"readFile": (path) => files.readFile(path, { "load": true }),
		"stat": (path) => files.stat(path, { "load": true }),
		"readdir": (path) => files.readdir(path, { "load": true }),
		"writeFile": refuse,
		"mkdir": refuse,
		"rm": refuse,
		"rename": refuse
	};
}

/** ESLint with the preset, loaded under almostnode, over the workspace `files`. */
async function load(files: RuntimeFs): Promise<Linter> {
	const archive = await fetch(new URL("./eslint-toolchain.tgz", import.meta.url));

	if (!archive.ok) {
		throw new Error(`the toolchain: ${archive.status} from ${archive.url}`);
	}

	const vfs = new RuntimeVfs(readOnly(files));

	for (const [path, bytes] of unpack(new Uint8Array(await archive.arrayBuffer()))) {
		const file = `${TOOLCHAIN}/${path}`;

		vfs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { "recursive": true });
		vfs.writeFileSync(file, bytes);
	}

	// (same-origin: the code is the toolchain the build packed; `cwd` is the workspace, which the preset reads its
	// tsconfig against as it's imported; packages resolved as Node resolves them — the toolchain is what Node loaded)
	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "cwd": "/workspace", "browserField": false });
	const loaded = await runtime.execute(`
module.exports = (async () => {
	const { ESLint } = require("eslint");
	const { "default": preset } = await import("@brianjenkins94/util/eslint");
	const options = { "cwd": "/workspace", "overrideConfigFile": true, "overrideConfig": preset };
	const linting = new ESLint(options);
	const fixing = new ESLint({ ...options, "fix": true });
	const messages = (result) => result.messages.map((message) => ({ "line": message.line, "column": message.column, "endLine": message.endLine, "endColumn": message.endColumn, "message": message.message, "ruleId": message.ruleId, "severity": message.severity, "fixable": message.fix !== undefined }));

	return {
		"lint": async (text, file) => messages((await linting.lintText(text, { "filePath": file }))[0]),
		"fix": async (text, file) => {
			const [result] = await fixing.lintText(text, { "filePath": file });

			return { "output": result.output ?? text, "fixed": result.output !== undefined && result.output !== text };
		}
	};
})();
`, ENTRY);

	return await (loaded.exports as Promise<Linter>);
}

let linter: Promise<Linter> | undefined;

globalThis.addEventListener("message", (event: MessageEvent) => {
	const data = event.data as { "runtime"?: MessagePort; "id"?: number; "lint"?: { "file": string; "text": string }; "fix"?: { "file": string; "text": string } };

	if (data.runtime !== undefined) {
		const link = connectRuntime(data.runtime, { "name": "eslint" });
		const started = performance.now();

		linter = link.ready.then(() => load(link.fs));
		linter.then(() => {
			globalThis.postMessage({ "booted": true, "ms": Math.round(performance.now() - started) });
		}, (error: unknown) => {
			globalThis.postMessage({ "failed": error instanceof Error ? error.stack ?? error.message : String(error) });
		});

		return;
	}

	const { id } = data;

	if (id === undefined || linter === undefined) {
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
