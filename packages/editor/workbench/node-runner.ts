import type { Hub } from "@brianjenkins94/hub";
import type { RunRegistry } from "./runs";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { virtualUrl } from "../shared/virtual-path";
import { createRunRegistry } from "./runs";

const LAUNCH_WAIT_MS = 60_000;

export type NodeOutput = (stream: "out" | "err", data: string) => void;
export interface NodeRunHooks {
	"runId"?: string;
	"onOutput": NodeOutput;
	"signal"?: AbortSignal;
	"onListening"?: (port: number) => void;
	"noDebug"?: boolean;
}

export interface NodeRunner {
	"runs": RunRegistry;
	"debug": (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks & { "args"?: string[] }) => Promise<{ "attached": boolean; "exitCode": number }>;
	"sendStdin": (data: string) => void;
	"endStdin": () => void;
	"isRunning": () => boolean;
	"startDevServer": (port: number, root: string) => Promise<string>;
	"stopDevServer": (port: number) => Promise<void>;
	"onDevServerUpdate": (port: number, handler: (message: unknown) => void) => () => void;
	"onDevServerClosed": (port: number, handler: () => void) => () => void;
}

export function createNodeRunner(hub: Hub, workspaceBuffer?: SharedArrayBuffer): NodeRunner {
	let currentRunId: string | undefined;
	const rpc = createRpcClient(hub);
	let devWorker: Worker | undefined;

	const startWorker = (): void => {
		if (devWorker === undefined) {
			devWorker = new Worker(new URL("./lsp/node-worker.js", location.href), { "type": "module" });
			watchWorker(devWorker, "node-worker");
			hub.link(portTransport(devWorker));
		}
	};

	serve(hub, "workspace.buffer", () => workspaceBuffer ?? null);

	const startDebug = (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks & { "args"?: string[] }): Promise<{ "attached": boolean; "exitCode": number }> => new Promise((resolve) => {
		const runId = hooks.runId ?? crypto.randomUUID();

		currentRunId = runId;
		let settled = false;

		const offOutput = hub.subscribe(`node.out.${runId}`, (data) => {
			const message = data as { "stream": "out" | "err"; "data": string };

			hooks.onOutput(message.stream, message.data);
		});
		const offListening = hub.subscribe(`node.listening.${runId}`, (data) => {
			startWorker();
			hooks.onListening?.((data as { "port": number }).port);
		});

		const offExit = hub.subscribe(`node.exit.${runId}`, (data) => {
			finish(true, (data as { "exitCode"?: number }).exitCode ?? 0);
		});
		const offDeclined = hub.subscribe(`debug.declined.${runId}`, () => {
			finish(false, 0);
		});

		const onAbort = (): void => {
			hub.publish("debug.stop", { "runId": runId });
			finish(true, 130);
		};

		function finish(attached: boolean, exitCode: number): void {
			if (settled) {
				return;
			}

			settled = true;
			offOutput();
			offListening();
			offExit();
			offDeclined();
			if (currentRunId === runId) {
				currentRunId = undefined;
			}

			hooks.signal?.removeEventListener("abort", onAbort);
			resolve({ "attached": attached, "exitCode": exitCode });
		}

		if (hooks.signal !== undefined) {
			if (hooks.signal.aborted) {
				onAbort();

				return;
			}

			hooks.signal.addEventListener("abort", onAbort, { "once": true });
		}

		void hub.whenInterested("debug.launch", LAUNCH_WAIT_MS).then((listening) => {
			if (settled) {
				return;
			}

			if (!listening) {
				finish(false, 0);

				return;
			}

			hub.publish("debug.launch", { "runId": runId, "file": file, "cwd": cwd, "env": env, ...hooks.args === undefined ? {} : { "args": hooks.args }, ...hooks.noDebug === true ? { "noDebug": true } : {} });
		});
	});

	const runs = createRunRegistry(hub);

	serve(hub, "runs.begin", (args) => {
		const { title, cwd, entry, runtime } = (args ?? {}) as { "title"?: unknown; "cwd"?: unknown; "entry"?: unknown; "runtime"?: unknown };
		let stopped = false;
		const run = runs.start({ "title": typeof title === "string" ? title : "debug", "kind": "task", "cwd": typeof cwd === "string" ? cwd : "/workspace", "origin": { "other": "Run and Debug" }, "runtime": typeof runtime === "string" ? runtime : "tsval", ...typeof entry === "string" && entry !== "" ? { "entry": entry } : {} }, () => {
			stopped = true;
			hub.publish("debug.stop", { "runId": run.id });
		});
		const offListening = hub.subscribe(`node.listening.${run.id}`, (data) => {
			const port = (data as { "port"?: unknown } | null)?.port;

			if (typeof port === "number") {
				run.update({ "kind": "service", "port": port });
			}
		});
		const off = hub.subscribe(`node.exit.${run.id}`, (data) => {
			off();
			offListening();
			run.end((data as { "exitCode"?: number } | null)?.exitCode ?? 0, stopped);
		});

		return { "id": run.id };
	});

	return {
		"runs": runs,
		"debug": (file, cwd, env, hooks) => startDebug(file, cwd, env, hooks),
		"sendStdin": (data) => {
			if (currentRunId !== undefined) {
				hub.publish(`node.stdin.${currentRunId}`, { "data": data });
			}
		},
		"endStdin": () => {
			if (currentRunId !== undefined) {
				hub.publish(`node.stdin.${currentRunId}`, { "end": true });
			}
		},
		"isRunning": () => currentRunId !== undefined,
		"startDevServer": async (port, root) => {
			startWorker();
			await rpc.request("preview.start", { "port": port, "root": root }, { "timeoutMs": 30_000, "waitForResponderMs": 30_000 });

			const tab = await rpc.request("virtual.tab", undefined, { "timeoutMs": 5000, "waitForResponderMs": 5000 }) as string;

			const url = virtualUrl(location.href.split("__vscode__/")[0]!, tab, port);

			hub.publish("preview.ready", { "port": port, "url": url });

			return url;
		},
		"stopDevServer": async (port) => {
			hub.publish("preview.close", { "port": port });
			await rpc.request("preview.stop", { "port": port }, { "timeoutMs": 10_000 }).catch(() => undefined);
		},
		"onDevServerUpdate": (port, handler) => hub.subscribe(`preview.hmr.${String(port)}`, (message) => {
			handler(message);
		}),
		"onDevServerClosed": (port, handler) => hub.subscribe("preview.close", (data) => {
			if ((data as { "port"?: number }).port === port) {
				handler();
			}
		})
	};
}
