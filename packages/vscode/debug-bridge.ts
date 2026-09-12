/**
 * Dev-only host-page debug bridge — `window.__editor` inside the workbench iframe.
 *
 * Driving the workbench through browser automation is slow and flaky (keyboard shortcuts don't forward, the
 * command palette can't be opened, monaco edits garble, the Output channel is virtualized). This bridge gives
 * a scriptable seam instead: from DevTools or automation, reach it as
 * `document.querySelector("iframe").contentWindow.__editor`.
 *
 * It's built on the vscode extension API captured from the default (hello) extension — `getApi()` returns the
 * full `typeof vscode` namespace — so it can run commands, read/replace the active document, read diagnostics,
 * and hand back the RAW extension API for ad-hoc poking (incl. the TypeScript language features, exposed via
 * `tsExtension()`/`hoverAt()` so we can see what type access the host already offers before bundling our own).
 *
 * Gated to localhost, so it never ships to the deployed Pages site. (The entry is always built in production
 * mode, so a hostname check is used rather than import.meta.env.DEV.)
 */
/* eslint-disable ts/no-explicit-any */

type Api = any;

let resolveReady: () => void;
const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });

/** Install `window.__editor`. `getApi` is read lazily so the bridge exists before the API is captured;
 *  `ready` resolves once it is (call `markBridgeReady`). No-op off localhost. */
export function installDebugBridge(getApi: () => Api): void {
	if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
		return;
	}

	const requireApi = (): Api => {
		const api = getApi();

		if (api === null) {
			throw new Error("[__editor] extension API not ready yet — `await window.__editor.ready` first");
		}

		return api;
	};

	const bridge = {
		"ready": readyPromise,

		/** The raw vscode extension API namespace, for anything not wrapped below. */
		get "api"(): Api { return requireApi(); },

		/** Invoke any command (the reliable stand-in for the command palette, which automation can't open). */
		"runCommand": (id: string, ...args: any[]): Promise<any> => requireApi().commands.executeCommand(id, ...args),

		/** All registered command ids, optionally filtered by substring. */
		"listCommands": async (filter?: string): Promise<string[]> => {
			const all: string[] = await requireApi().commands.getCommands(true);

			return filter === undefined ? all : all.filter((id) => id.includes(filter));
		},

		"getActiveText": (): string | undefined => requireApi().window.activeTextEditor?.document.getText(),

		/** Replace the whole active document (reliable, unlike simulated typing). */
		"setActiveText": async (text: string): Promise<boolean> => {
			const api = requireApi();
			const editor = api.window.activeTextEditor;

			if (editor === undefined) {
				return false;
			}

			const document = editor.document;
			const range = new api.Range(document.positionAt(0), document.positionAt(document.getText().length));

			return editor.edit((builder: any) => builder.replace(range, text));
		},

		"openFile": async (path: string): Promise<void> => {
			const api = requireApi();
			const document = await api.workspace.openTextDocument(api.Uri.file(path));

			await api.window.showTextDocument(document);
		},

		"getDiagnostics": (): { "uri": string; "items": any[] }[] => requireApi().languages.getDiagnostics()
			.map(([uri, items]: [any, any[]]) => ({ "uri": uri.toString(), "items": items })),

		// ── TypeScript access via the host (see if we can drop the engine's bundled typescript) ──

		/** The built-in TypeScript extension's exported API (control surface: configurePlugin, etc.). */
		"tsExtension": async (): Promise<any> => {
			const ext = requireApi().extensions.getExtension("vscode.typescript-language-features");

			if (ext === undefined) {
				return undefined;
			}

			if (!ext.isActive) {
				await ext.activate();
			}

			return { "id": ext.id, "isActive": ext.isActive, "exports": ext.exports, "exportKeys": ext.exports === undefined ? [] : Object.keys(ext.exports) };
		},

		/** Every installed extension id + whether it's active — to see what the host already provides. */
		"listExtensions": (): { "id": string; "isActive": boolean }[] => requireApi().extensions.all.map((ext: any) => ({ "id": ext.id, "isActive": ext.isActive })),

		/** Run the TS language service's hover at a position of the active doc (types WITHOUT a bundled ts). */
		"hoverAt": async (line: number, character: number): Promise<any> => {
			const api = requireApi();
			const uri = api.window.activeTextEditor?.document.uri;

			if (uri === undefined) {
				return undefined;
			}

			return api.commands.executeCommand("vscode.executeHoverProvider", uri, new api.Position(line, character));
		}
	};

	(window as any).__editor = bridge;
	console.log("[__editor] debug bridge installed (localhost). Reach it via iframe.contentWindow.__editor");
}

/** Resolve `window.__editor.ready` — call once the extension API is captured. */
export function markBridgeReady(): void {
	resolveReady();
}
