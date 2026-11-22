/** @jsxImportSource preact */
import { isEditorTop, seedFiles } from "./shared/instance";
import "./shared/hidden-timers";
import { createHub, createRpcClient, serve, windowTransport } from "@brianjenkins94/hub";
import { consoleCollector, installHubCollector, installWindowMessageProbe, linkDebugMcp, linkServiceWorkerHub, servePageTools, tapConsoleAndErrors } from "@brianjenkins94/observability";
import moduleVersions from "editor:versions";
import { ensureCrossOriginIsolated } from "./app/coi";
import { hostLog } from "./app/logging";
import { createVscodeWindow } from "./app/vscode";
import { reportArchitecture } from "./shared/architecture";
import { reportSpanMetrics } from "./shared/editor-metrics";
import { followResets, resetAsked, resetEditor, waitForReset } from "./shell/reset";

const reset = isEditorTop() ? resetAsked() : undefined;
const isolated = reset === undefined && ensureCrossOriginIsolated();

if (reset === "wait") {
	waitForReset();
} else if (reset !== undefined) {
	void resetEditor((import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/", reset === "all");
} else if (isolated && isEditorTop()) {
	followResets();
	performance.mark("shell/import");
	void import("./shell/shell.tsx").then(({ renderShell }) => {
		renderShell();
	});
} else if (isolated) {
	const seeded = seedFiles(location.search);
	const files = Promise.all([import("editor:workspace"), import("editor:types")]).then(([workspace, types]) => [...seeded === undefined ? workspace.default : Object.entries(seeded).map(([path, contents]) => ({ "path": `/workspace/${path}`, "contents": contents })), ...types.default]);

	const rootHub = createHub({ "id": "root" });

	const architecture = reportArchitecture(rootHub);

	installWindowMessageProbe(architecture, (source) => {
		if (source === window.parent) {
			return "shell";
		}

		return [...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === source && frame.src.includes("/__vscode__/host.html")) ? "workbench" : undefined;
	});
	const spans = reportSpanMetrics(rootHub);

	installHubCollector(rootHub, (record) => {
		consoleCollector(record);
		spans.record(record);

		const attrs = (record.attrs ?? {}) as { "src"?: unknown; "line"?: unknown; "stack"?: unknown; "message"?: unknown; "reason"?: unknown };

		if (record.level === "error" && ("src" in attrs || record.message === "uncaught error" || record.message === "unhandled rejection" || record.message.startsWith("unhandledrejection: "))) {
			rootHub.publish("session.event", { "name": "error", "error": { "message": String(attrs.message ?? attrs.reason ?? record.message), "stack": typeof attrs.stack === "string" ? attrs.stack : undefined, "source": record.context?.["source"] } });
		}
	});

	tapConsoleAndErrors(rootHub, "host");
	const tab = crypto.randomUUID().slice(0, 8);

	linkServiceWorkerHub(rootHub);
	const tabRpc = createRpcClient(rootHub);

	serve(rootHub, `virtual.request.${tab}`, async (args) => tabRpc.request("virtual.request", args, { "timeoutMs": 30_000, "waitForResponderMs": 10_000 }));
	serve(rootHub, `capability.decide.${tab}`, async (args) => tabRpc.request("capability.decide", args, { "timeoutMs": 300_000, "waitForResponderMs": 10_000 }));
	serve(rootHub, `capability.record.${tab}`, async (args) => tabRpc.request("capability.record", args, { "timeoutMs": 30_000, "waitForResponderMs": 10_000 }));
	serve(rootHub, "virtual.tab", () => tab);
	linkDebugMcp(rootHub);
	void import("./app/tools").then(({ editorTools }) => {
		servePageTools(rootHub, { "tab": tab, "tools": editorTools(rootHub) });
	});

	const embedded = window.parent !== window;

	const vscodeWindow = createVscodeWindow({
		"workspaceFolder": "/workspace",
		"files": files,
		"moduleVersions": moduleVersions,
		"rootHub": rootHub,
		"tab": tab,
		"openEditors": seeded === undefined ? ["/workspace/src/index.ts"] : [],
		"onSave": (path: string, contents: string) => {
			hostLog.info("saved", { "path": path, "bytes": contents.length });
		}
	});

	if (embedded) {
		rootHub.link(windowTransport(window.parent));
		rootHub.subscribe("project.openFiles", (data) => {
			const request = data as { "files"?: { "path": string; "contents"?: string; "bytes"?: Uint8Array }[]; "openEditors"?: string[] } | null;

			if (Array.isArray(request?.files) && request.files.length > 0) {
				vscodeWindow.replaceProject(request.files, request.openEditors ?? []);
				hostLog.info("project.openFiles", { "files": request.files.length });
			}
		});
		hostLog.info("shell link established");
	}
}
