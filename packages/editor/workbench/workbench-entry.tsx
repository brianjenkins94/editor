/** @jsxImportSource preact */
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import type { WorkspaceFs } from "./workspace-fs";
import "../shared/instance";
import "../shared/hidden-timers";
import { classifyUrl, identifyWorker } from "@brianjenkins94/editor-api/probes";
// eslint-disable-next-line perfectionist/sort-imports -- theme/documents above, first on purpose: it has to run before Lit does
import { failureText } from "@brianjenkins94/editor-api/failures";
import { countDocumentOpens } from "@brianjenkins94/editor-api/documents";
import { linkRuntime } from "@brianjenkins94/editor-api/runtime";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { boot, ExtensionHostKind, installMonacoProbes, onWorkbenchActivity, registerExtension, registerFileSystemOverlay, setTerminalProcessFactory } from "@brianjenkins94/monaco-vscode-api/main";
import type { Gauge } from "@brianjenkins94/observability";
import { isCancellation, observe } from "@brianjenkins94/observability";
import bridgeExtension from "bridge:extension";
import capabilitiesExtension from "capabilities:extension";
import changeProblemsExtension from "change-problems:extension";
import settingsDefaults from "editor:settings-defaults";
import eslintExtension from "eslint:extension";
import historyExtension from "history:extension";
import insightsExtension from "insights:extension";
import marginExtension from "margin:extension";
import notesExtension from "notes:extension";
import typeQueriesExtension from "type-queries:extension";
import cosmeticExtension from "cosmetic:extension";
import cspellExtension from "cspell:extension";
import { render } from "preact";
import sourceControlExtension from "source-control:extension";
import tsvalExtension from "tsval:extension";
import { NETWORK_PROBES } from "../shared/architecture";
import { reportWorkbenchMetrics } from "../shared/editor-metrics";
import { windowClientTransport } from "../shared/pane-link";
import { architectureStore } from "./architecture-store";
import { installTypeAcquisition } from "./ata";
import { installBablr } from "./bablr";
import { wireWorkbenchHub } from "./bridge-link";
import { installCapabilityConfirm } from "./capability-confirm";
import { installCheckpoints } from "./checkpoints";
import { installCiOutcomes } from "./ci-outcomes";
import { installCiStatus } from "./ci-status";
import { installCodeProblems } from "./code-problems";
import { installCodeReach } from "./code-reach";
import { installCodeRefactor } from "./code-refactor";
import { installDebugBridge, markBridgeReady, markContributedLoaded } from "./debug-bridge";
import { installDecisions } from "./decisions";
import { installEditorState } from "./editor-state";
import { installEvidence } from "./evidence";
import { loadContributedExtensions, registerExtensionFolder } from "./extensions";
import { installFeaturesView } from "./features-view";
import { installFsTrace } from "./fs-trace";
import { installGitHistory } from "./git-history";
import { installGitPush } from "./git-push";
import { installGitRefs } from "./git-refs";
import { commitPart, installGitReview } from "./git-review";
import { installGitService } from "./git-service";
import { createNodeModulesProvider } from "./node-modules-provider";
import { createNodeRunner } from "./node-runner";
import { installPaneViews } from "./pane-views";
import { installPreviewSessions } from "./preview-session";
import { installProfileTimes } from "./profile-times";
import { installEditHistory } from "./edit-history";
import { announceWorkspaceSettings, followProjectSwitches, openProject, OVERRIDABLE_DEFAULTS, serveFiles, serveOrigin } from "./project";
import { markReady, whenDebuggerUp } from "./readiness";
import { installScriptRun } from "./script-run";
import { installTarballs } from "./tarballs";
import { installTasks } from "./tasks";
import { createBashProcess, serveTerminalState } from "./terminal";
import { installTestNotice } from "./test-notice";
import { installTestRuns } from "./test-runs";
import { followSystemTheme, showVsCodeTheme } from "./theme-follow";
import { serveUnpushed } from "./unpushed";
import { pinned, watchVersions } from "./versions";
import { Workbench } from "./Workbench";
import { configuration, keybindings } from "./workspace";
import { holdFiles, installWorkspaceFs } from "./workspace-fs";
import { installWorkspaceTools } from "./workspace-tools";
import "theme/documents";

performance.mark("editor/entry");

interface Init { "files": WorkbenchFile[]; "openEditors": string[]; "workspaceFolder"?: string; "moduleVersions"?: Record<string, string>; "tab"?: string }

const host = window.opener ?? window.parent;
const paneId = new URLSearchParams(location.search).get("pane") ?? "editor";

window.addEventListener("scroll", () => {
	if (document.body.scrollLeft !== 0 || document.body.scrollTop !== 0) {
		document.body.scrollLeft = 0;
		document.body.scrollTop = 0;
	}

	if (document.documentElement.scrollLeft !== 0 || document.documentElement.scrollTop !== 0) {
		document.documentElement.scrollLeft = 0;
		document.documentElement.scrollTop = 0;
	}
}, true);

const workbenchHub = createHub({ "id": "workbench" });

workbenchHub.link(windowClientTransport(paneId, host));

const { "log": paneLog, architecture } = observe(workbenchHub, { "network": NETWORK_PROBES });

installMonacoProbes(architecture, {
	"identifyWorker": identifyWorker,
	"classifyUrl": classifyUrl,
	"linkRuntime": (port, name, session) => linkRuntime(workbenchHub, port, name, session)
});

window.addEventListener("error", (event) => {
	if (!event.message.includes("ResizeObserver loop")) {
		paneLog.error("uncaught error", {
			"message": event.message,
			"file": event.filename,
			"line": event.lineno,
			"stack": stackOf(event.error)
		});
	}
});
window.addEventListener("unhandledrejection", (event) => {
	const { reason } = event;

	if (isCancellation(reason)) {
		event.preventDefault();

		return;
	}

	paneLog.error("unhandled rejection", {
		"reason": reasonText(reason),
		"stack": stackOf(reason instanceof ErrorEvent
			? reason.error
			: reason)
	});
});

function stackOf(thrown: unknown): string | undefined {
	const stack = (thrown as { "stack"?: unknown } | null | undefined)?.stack;

	return typeof stack === "string"
		? stack
		: undefined;
}

function reasonText(reason: unknown): string {
	if (reason instanceof ErrorEvent) {
		return `${reason.message || "a worker failed"}${reason.filename === ""
			? ""
			: ` (${reason.filename}:${reason.lineno})`}`;
	}

	return reason instanceof Error
		? reason.message
		: failureText(reason);
}

function builtIn(extension: { "base": string; "manifest": Parameters<typeof registerExtensionFolder>[0] }, kind: ExtensionHostKind): ReturnType<typeof registerExtensionFolder> {
	return registerExtensionFolder(extension.manifest, new URL(extension.base, location.href), kind);
}

function errText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}

let workbenchContainer: HTMLElement | undefined;
let init: Init | undefined;
let booted = false;
let publishColors: (() => void) | undefined;

// eslint-disable-next-line ts/no-explicit-any
let vscodeApi: any = null;
let documentOpens: Gauge | undefined;

let markApiReady: () => void;
const apiReady = new Promise<void>((resolve) => {
	markApiReady = resolve;
});

function runCommand(command: string): void {
	const pending = vscodeApi?.commands?.executeCommand(command) as Promise<unknown> | undefined;

	pending?.catch((error: unknown) => {
		console.error("[vscode] command failed", command, failureText(error));
	});
}

function bootWithFallbackViewport(root: HTMLElement): void {
	if (root.clientWidth > 0 && root.clientHeight > 0) {
		return;
	}

	/* eslint-disable webawesome/no-inline-styles -- fallback viewport dims for an unlaid-out host (0×0), so the workbench can measure at boot; restored below. Intrinsic geometry, not themeable chrome. */
	root.style.width = "1280px";
	root.style.height = "720px";
	/* eslint-enable webawesome/no-inline-styles */

	const restore = (): void => {
		if (window.innerWidth === 0 || window.innerHeight === 0) {
			return;
		}

		root.style.removeProperty("width");
		root.style.removeProperty("height");
		window.removeEventListener("resize", restore);
	};

	window.addEventListener("resize", restore);
}

const BOOT_WAITS_AT_MOST_MS = 10_000;
const PAINT_FIRST_MS = 100;

function maybeBoot(): void {
	if (booted || workbenchContainer === undefined || init === undefined) {
		return;
	}

	booted = true;
	performance.mark("editor/boot");
	const { files, openEditors, workspaceFolder, moduleVersions, tab } = init;

	const bootSpan = paneLog.span("editor.workbench.workbench-entry.boot", { "files": files.length, "openEditors": openEditors.length });
	const { "promise": bootOver, "resolve": bootDone } = Promise.withResolvers<void>();
	const mounting = bootOver.then(async () => installWorkspaceFs(files, paneLog, { "hub": workbenchHub, "architecture": architecture })).catch((error: unknown) => {
		bootSpan.error("workspace zen-fs failed", {
			"error": errText(error)
		});

		return undefined;
	});

	holdFiles(mounting, workspaceFolder ?? "/workspace");
	setTimeout(bootDone, BOOT_WAITS_AT_MOST_MS);

	let workspaceFs: WorkspaceFs | undefined;

	bootWithFallbackViewport(document.documentElement);

	const baseFiles = files.filter((file) => file.readonly === true).map((file) => (OVERRIDABLE_DEFAULTS.has(file.path.slice((workspaceFolder ?? "/workspace").length + 1))
		? { ...file, "readonly": false }
		: file));

	boot({
		"layout": "workbench",
		"container": workbenchContainer,
		"configurationDefaults": {
			"window.menuBarVisibility": "hidden",
			"window.customTitleBarVisibility": "never",
			"window.commandCenter": false,
			"workbench.layoutControl.enabled": false,
			"scm.diffDecorations": "none",
			"window.density.layout": "compact",
			"workbench.experimental.modernUIUppercaseViewHeaders": true
		},
		"hiddenViewContainers": ["workbench.view.scm", "workbench.view.extensions"],
		"windowIndicator": { "label": "", "command": "" },
		"files": baseFiles,
		"openEditors": [],
		"workspaceFolder": workspaceFolder,
		"configuration": configuration,
		"keybindings": keybindings,
		"onSave": (path, contents) => {
			workbenchHub.publish("workbench.save", { "path": path, "contents": contents });
			paneLog.info("saved", { "path": path, "bytes": contents.length });
		}
	})
		.then(async () => {
			bootSpan.info("monaco booted");
			publishColors = showVsCodeTheme(workbenchHub);
			setTimeout(bootDone, PAINT_FIRST_MS);
			workspaceFs = await mounting;
			markReady("workspace");
			Object.assign(pinned, moduleVersions);
			const nodeModules = createNodeModulesProvider(workspaceFolder ?? "/workspace", pinned);

			registerFileSystemOverlay(0, nodeModules);
			void apiReady.then(() => {
				const api = vscodeApi as typeof import("vscode");

				api.commands.registerCommand("editor.nodeModules.prefetch", async (files: unknown) => nodeModules.prefetchFor(Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [], async (path) => Promise.resolve(api.workspace.fs.readFile(api.Uri.file(path))).then((bytes) => new TextDecoder().decode(bytes), () => undefined)));
			});

			void apiReady.then(async () => (openEditors.length > 0
				? openProject(vscodeApi, workspaceFolder ?? "/workspace", paneLog, { "openEditors": openEditors })
				: undefined))
				.catch((error: unknown) => {
					bootSpan.error("initial open failed", {
						"error": errText(error)
					});
				});

			registerExtension({
				"name": "editor-defaults",
				"publisher": "brianjenkins94",
				"version": "0.0.1",
				"engines": { "vscode": "*" },
				"contributes": { "configurationDefaults": settingsDefaults }
			});

			const bridgeExt = builtIn(bridgeExtension, ExtensionHostKind.LocalProcess);

			bridgeExt.setAsDefaultApi().catch((error: unknown) => {
				bootSpan.error("setAsDefaultApi failed", {
					"error": errText(error)
				});
			});
			bridgeExt.getApi().then((api: unknown) => {
				vscodeApi = api;
				documentOpens = countDocumentOpens(api as typeof import("vscode"));
				markApiReady();
				markBridgeReady();
				markReady("api");
				whenDebuggerUp(api as typeof import("vscode"), workbenchHub).catch((error: unknown) => {
					bootSpan.error("the debugger didn't come up", {
						"error": errText(error)
					});
				});
				void announceWorkspaceSettings(api as typeof import("vscode"), workspaceFolder ?? "/workspace", workspaceFs);
				installTypeAcquisition(api as typeof import("vscode"), workspaceFolder ?? "/workspace", pinned, (path) => workspaceFs?.has(path) ?? false, paneLog);
				watchVersions(api as typeof import("vscode"));
				installTarballs(api as typeof import("vscode"), workbenchHub);
				const nodeRunner = createNodeRunner(workbenchHub, workspaceFs?.buffer);

				installEditorState(workbenchHub, api as typeof import("vscode"), paneLog);
				installFsTrace(workbenchHub, api as typeof import("vscode"), paneLog);
				installPaneViews(api as typeof import("vscode"));
				const bablr = installBablr(api as typeof import("vscode"), workbenchHub, paneLog);
				installEditHistory(api as typeof import("vscode"), workbenchHub, bablr, paneLog);

				setTerminalProcessFactory((fire, cwd) => createBashProcess(api as typeof import("vscode"), nodeRunner, workbenchHub, fire, cwd));
				installWorkspaceTools(api as typeof import("vscode"), workbenchHub);
				installScriptRun(api as typeof import("vscode"), workbenchHub);
				serveTerminalState(nodeRunner, workbenchHub);
				installTasks(api as typeof import("vscode"), nodeRunner, workbenchHub, paneLog);
				installPreviewSessions(api as typeof import("vscode"), nodeRunner, workbenchHub, paneLog);
				const evidence = installEvidence(api as typeof import("vscode"), workbenchHub, nodeRunner.runs, bablr, paneLog);
				installProfileTimes(api as typeof import("vscode"), workbenchHub, nodeRunner.runs, bablr, evidence, paneLog);

				wireWorkbenchHub(api as typeof import("vscode"), workbenchHub, paneLog, workspaceFs?.buffer);
				reportWorkbenchMetrics(workbenchHub, workspaceFs?.buffer, architectureStore(workbenchHub), documentOpens);
				const git = installGitService(api as typeof import("vscode"), workbenchHub, paneLog, { "part": commitPart });

				installGitReview(workbenchHub, git);
				installCodeProblems(api as typeof import("vscode"), workbenchHub, git, paneLog);
				installCodeRefactor(api as typeof import("vscode"), workbenchHub, paneLog);
				installCheckpoints(api as typeof import("vscode"), workbenchHub, git, paneLog);
				const remote = installGitPush(workbenchHub, paneLog);

				installCiStatus(api as typeof import("vscode"), workbenchHub, paneLog);

				installGitHistory(api as typeof import("vscode"), workbenchHub, remote);
				installGitRefs(api as typeof import("vscode"), workbenchHub, paneLog, bablr, remote);
				serveOrigin(workbenchHub, paneLog);
				serveFiles(api as typeof import("vscode"), workbenchHub, workspaceFolder ?? "/workspace", paneLog);
				serveUnpushed(workbenchHub);
				installDecisions(api as typeof import("vscode"), workbenchHub);
				installCodeReach(api as typeof import("vscode"), workbenchHub);
				installTestNotice(api as typeof import("vscode"), workbenchHub, paneLog, installTestRuns(api as typeof import("vscode"), workbenchHub, git, nodeRunner).runFile);
				installCiOutcomes(api as typeof import("vscode"), workbenchHub, paneLog);
				installFeaturesView(api as typeof import("vscode"), workbenchHub, paneLog);
				installCapabilityConfirm(api as typeof import("vscode"), workbenchHub, paneLog);

				followSystemTheme(api as typeof import("vscode"), workbenchHub, () => { publishColors?.(); });
				bootSpan.info("the bridge's vscode api, for core");
			}).catch((error: unknown) => {
				bootSpan.error("the bridge's setup failed", {
					"error": errText(error)
				});
			});

			builtIn(tsvalExtension, ExtensionHostKind.LocalProcess);

			for (const extension of [
				eslintExtension,
				changeProblemsExtension,
				historyExtension,
				sourceControlExtension,
				marginExtension,
				notesExtension,
				insightsExtension,
				capabilitiesExtension,
				typeQueriesExtension,
				cosmeticExtension,
				cspellExtension
			]) {
				builtIn(extension, ExtensionHostKind.LocalWebWorker);
			}

			void apiReady.then(() => loadContributedExtensions(vscodeApi as typeof import("vscode"), paneLog)).then(markContributedLoaded);

			bootSpan.info("extensions registered", {
				"extensions": [
					"bridge",
					"tsval",
					"eslint",
					"change-problems",
					"history",
					"source-control",
					"margin",
					"notes",
					"insights",
					"capabilities",
					"type-queries",
					"cosmetic",
					"cspell"
				]
			});
			workbenchHub.publish("workbench.online");
			bootSpan.end();
			void onWorkbenchActivity((event) => {
				workbenchHub.publish("session.event", event);
			});
		})
		.catch((error: unknown) => {
			bootSpan.error("workbench boot failed", {
				"error": errText(error)
			});
			bootSpan.end();
		});
}

const paneRpc = createRpcClient(workbenchHub);

void (async () => {
	for (;;) {
		try {
			performance.mark("editor/init-request");
			const data = await paneRpc.request("workbench.init", undefined, { "timeoutMs": 1500, "waitForResponderMs": 10_000 }) as Init;

			performance.mark("editor/init-received");

			init = {
				"files": data.files ?? [],
				"openEditors": data.openEditors ?? [],
				"workspaceFolder": data.workspaceFolder,
				"moduleVersions": data.moduleVersions,
				"tab": data.tab
			};
			maybeBoot();

			return;
		} catch (error) {
			performance.mark("editor/init-retry", {
				"detail": String(error)
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 250);
			});
		}
	}
})();

followProjectSwitches(workbenchHub, async (project) => {
	await apiReady;
	await openProject(vscodeApi, init?.workspaceFolder ?? "/workspace", paneLog, project);
}, paneLog);

installDebugBridge(() => vscodeApi);

render(
	<Workbench
		onReady={(container) => {
			performance.mark("editor/container");
			workbenchContainer = container;
			maybeBoot();
		}}
	/>,
	document.body
);

paneLog.info("pane ready", { "pane": paneId });
