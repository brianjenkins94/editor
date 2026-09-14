/**
 * The terminal's node runner — a dedicated, pod-style worker that runs `node <file>` through almostnode's
 * Runtime, OFF the workbench main thread and inside its OWN globalThis.
 *
 * Two problems this solves over running node in the main thread (the v1): a heavy/long script no longer freezes
 * the UI (it blocks THIS worker), and almostnode's `globalThis.process` shim can't leak into the workbench.
 *
 * Same almostnode-on-zen-fs pattern as server-host.ts: it runs on the SHARED workspace zen-fs (the SAB arrives
 * over a dedicated control port via receiveSharedWorkspace), so `node` sees exactly the files the editor,
 * type-checker and preview see — one filesystem. Dispatched AND observed over the hub: it serves the `node.run`
 * RPC and opens a span per run through relayLoggerToHub, so every execution shows in the observability plane
 * (federated up to the page's collector / debug-mcp). Mirrors debug-worker.ts's hub wiring.
 */
import { Runtime } from "@brianjenkins94/almostnode";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";

import { relayLoggerToHub } from "../../telemetry";

import { createZenfsVFS, receiveSharedWorkspace } from "./zenfs-vfs.js";

// Catch the shared workspace SAB from the spawner BEFORE anything runs (dedicated port; never the RPC channel).
receiveSharedWorkspace();

const hub = createHub({ "id": "node" });

hub.link(portTransport(globalThis as unknown as Worker));
const log = relayLoggerToHub(hub, "node");

let vfsPromise: ReturnType<typeof createZenfsVFS> | undefined;
const getVfs = (): ReturnType<typeof createZenfsVFS> => (vfsPromise ??= createZenfsVFS());

// The deploy base (this worker's served URL minus the "/__vscode__/…" tail), so a script's `file://` dynamic
// import resolves under the base-scoped service worker. Same computation as server-host.
const hereUrl = new URL(import.meta.url);
const vscodeCut = hereUrl.pathname.indexOf("/__vscode__/");
const base = hereUrl.origin + (vscodeCut === -1 ? "/" : hereUrl.pathname.slice(0, vscodeCut + 1));

/** Format a console argument the way node's console does (strings bare, everything else JSON-ish). */
function formatArg(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

interface RunArgs { "file": string; "cwd": string; "env": Record<string, string> }
interface RunResult { "stdout": string; "stderr": string; "exitCode": number }

serve(hub, "node.run", async (raw): Promise<RunResult> => {
	const { file, cwd, env } = raw as RunArgs;
	const vfs = await getVfs();

	if (!vfs.existsSync(file)) {
		return { "stdout": "", "stderr": `node: cannot find module '${file}'\n`, "exitCode": 1 };
	}

	const span = log.span("node.run", { "file": file, "cwd": cwd });
	let out = "";
	let err = "";
	let failure: string | undefined;
	// almostnode's module wrapper assigns globalThis.process; snapshot it and restore RIGHT AFTER the (synchronous)
	// run — BEFORE any logging below, so the logger doesn't write through the leftover process shim into `out`, and
	// so repeated runs on this worker don't inherit the previous script's shim.
	const savedProcess = (globalThis as { "process"?: unknown }).process;

	try {
		const runtime = new Runtime(vfs, {
			"cwd": cwd,
			"env": env,
			"base": base,
			"onStdout": (data: string) => { out += data; },
			"onStderr": (data: string) => { err += data; },
			"onConsole": (method: string, methodArgs: unknown[]) => {
				const line = `${methodArgs.map(formatArg).join(" ")}\n`;

				if (method === "error" || method === "warn") {
					err += line;
				} else {
					out += line;
				}
			}
		});

		runtime.runFile(file); // synchronous — blocks THIS worker, not the UI
	} catch (error) {
		failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
	} finally {
		(globalThis as { "process"?: unknown }).process = savedProcess; // restore before logging (see note above)
	}

	if (failure === undefined) {
		span.end({ "exitCode": 0, "stdoutBytes": out.length, "stderrBytes": err.length });

		return { "stdout": out, "stderr": err, "exitCode": 0 };
	}

	span.error("node run failed", { "error": failure });
	span.end({ "exitCode": 1 });

	return { "stdout": out, "stderr": `${err}${failure}\n`, "exitCode": 1 };
});
