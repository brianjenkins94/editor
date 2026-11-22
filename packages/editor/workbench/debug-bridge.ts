/* eslint-disable ts/no-explicit-any */

type Api = any;

let resolveReady: () => void;
const readyPromise = new Promise<void>((resolve) => {
	resolveReady = resolve;
});
let resolveContributed: () => void;
const contributedPromise = new Promise<void>((resolve) => {
	resolveContributed = resolve;
});

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
		"contributed": contributedPromise,

		get "api"(): Api { return requireApi(); },

		"runCommand": (id: string, ...args: any[]): Promise<any> => requireApi().commands.executeCommand(id, ...args),

		"listCommands": async (filter?: string): Promise<string[]> => {
			const all: string[] = await requireApi().commands.getCommands(true);

			return filter === undefined ? all : all.filter((id) => id.includes(filter));
		},

		"getActiveText": (): string | undefined => requireApi().window.activeTextEditor?.document.getText(),

		"setActiveText": (text: string): Promise<boolean> => new Promise((resolve) => {
			const api = requireApi();
			const editor = api.window.activeTextEditor;

			if (editor === undefined) {
				resolve(false);

				return;
			}

			const { document } = editor;
			const range = new api.Range(document.positionAt(0), document.positionAt(document.getText().length));

			resolve(editor.edit((builder: any) => builder.replace(range, text)));
		}),

		"openFile": async (path: string): Promise<void> => {
			const api = requireApi();
			const document = await api.workspace.openTextDocument(api.Uri.file(path));

			await api.window.showTextDocument(document);
		},

		"getDiagnostics": (): { "uri": string; "items": any[] }[] => requireApi().languages.getDiagnostics().map(([uri, items]: [any, any[]]) => ({ "uri": uri.toString(), "items": items })),

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

		"listExtensions": (): { "id": string; "isActive": boolean }[] => requireApi().extensions.all.map((ext: any) => ({ "id": ext.id, "isActive": ext.isActive })),

		"hoverAt": (line: number, character: number): Promise<any> => new Promise((resolve) => {
			const api = requireApi();
			const uri = api.window.activeTextEditor?.document.uri;

			if (uri === undefined) {
				resolve(undefined);

				return;
			}

			resolve(api.commands.executeCommand("vscode.executeHoverProvider", uri, new api.Position(line, character)));
		})
	};

	(window as any).__editor = bridge;
	console.log("[__editor] debug bridge installed (localhost). Reach it via iframe.contentWindow.__editor");
}

export function markBridgeReady(): void {
	resolveReady();
}

export function markContributedLoaded(): void {
	resolveContributed();
}
