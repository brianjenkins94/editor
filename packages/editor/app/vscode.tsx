/** @jsxImportSource preact */
import type { Hub } from "@brianjenkins94/hub";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import { serve } from "@brianjenkins94/hub";
import { windowServerTransport } from "../shared/pane-link";
import { hostLog } from "./logging";

const PANE_ID = "editor";

export interface VscodeWindowOptions {
	"files"?: WorkbenchFile[] | Promise<WorkbenchFile[]>;
	"openEditors"?: string[];
	"workspaceFolder"?: string;
	"moduleVersions"?: Record<string, string>;
	"onSave"?: (path: string, contents: string) => void;
	"mountInto"?: HTMLElement;
	"rootHub"?: Hub;
	"tab"?: string;
}

export interface ProjectFile { "path": string; "contents"?: string; "bytes"?: Uint8Array }

export interface VscodeWindowHandle {
	"whenReady": Promise<void>;
	"openProject": (files: ProjectFile[], openEditors: string[]) => void;
	"replaceProject": (files: ProjectFile[], openEditors: string[]) => void;
}

let booted = false;

export function createVscodeWindow(options: VscodeWindowOptions = {}): VscodeWindowHandle {
	if (booted) {
		return { "whenReady": Promise.resolve(), "openProject": () => { /* singleton already booted elsewhere */ } };
	}

	booted = true;

	const span = hostLog.span("editor.app.vscode.editor-window");

	let markReady: () => void;
	const whenReady = new Promise<void>((resolve) => {
		markReady = resolve;
	});

	const { files = [], openEditors = [], workspaceFolder, moduleVersions, onSave, mountInto = document.body, rootHub, tab } = options;
	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";

	const iframe = document.createElement("iframe");

	const query = new URLSearchParams({ "pane": PANE_ID });

	for (const extension of new URLSearchParams(location.search).getAll("extension")) {
		query.append("extension", extension);
	}

	iframe.src = base + "__vscode__/host.html?" + query.toString();

	// eslint-disable-next-line webawesome/no-inline-styles, webawesome/no-css-in-strings -- an iframe filling its own mount box; not themeable chrome
	iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
	// eslint-disable-next-line webawesome/no-inline-styles -- give the mount box a definite height so the iframe can measure at boot
	mountInto.style.height ||= "100%";
	mountInto.appendChild(iframe);
	span.info("workbench mounted (fill)", { "pane": PANE_ID });

	if (rootHub === undefined) {
		throw new Error("createVscodeWindow requires a rootHub — the workbench boots over it");
	}

	const paneHub = rootHub;

	paneHub.link(windowServerTransport(PANE_ID, () => iframe.contentWindow ?? undefined));

	serve(paneHub, "workbench.init", async () => ({ "files": await files, "openEditors": openEditors, "workspaceFolder": workspaceFolder, "moduleVersions": moduleVersions, "tab": tab }));

	paneHub.subscribe("workbench.online", () => {
		span.end();
		markReady();
	});
	paneHub.subscribe("workbench.save", (data) => {
		const save = data as { "path"?: string; "contents"?: string };

		if (typeof save.path === "string" && typeof save.contents === "string") {
			onSave?.(save.path, save.contents);
		}
	});

	const openProject = (projectFiles: ProjectFile[], entryFiles: string[]): void => {
		void whenReady.then(() => {
			paneHub.publish("workbench.openProject", { "files": projectFiles, "openEditors": entryFiles });
		});
	};

	const replaceProject = (projectFiles: ProjectFile[], entryFiles: string[]): void => {
		void whenReady.then(() => {
			paneHub.publish("workbench.openProject", { "files": projectFiles, "openEditors": entryFiles, "replace": true });
		});
	};

	return { "whenReady": whenReady, "openProject": openProject, "replaceProject": replaceProject };
}
