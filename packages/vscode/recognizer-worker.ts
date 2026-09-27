/**
 * Reverse-projection worker — runs the game recognizer OFF the main thread, where TypeScript is loaded.
 *
 * WHY a worker: the recognizer needs a `typescript` to parse. Importing ts into the main workbench bundle would add
 * ~7MB to main.js. Built in build.ts pass 2 (alongside the LSP workers, with `dedupe:["typescript"]` + the manualChunks
 * that force ONE shared `lsp/typescript` chunk), this worker REFERENCES that same chunk — the editor's ts, not a second
 * bundled copy. ts is dynamic-imported LAZILY on the first request, so spawning the worker stays cheap.
 *
 * Protocol: `{ id, files }` in → `{ id, model }` (a plain-JSON GameModel) or `{ id, error }` out. Driven by
 * game-projection.ts in the workbench realm.
 */
import type { TsApi } from "./game-recognizer";
import { anchorGame } from "./game-anchors";
import { recognizeGame } from "./game-recognizer";

interface ProjectRequest { "id": number; "files": Record<string, string> }

let tsApi: TsApi | undefined;

globalThis.onmessage = async (event: MessageEvent<ProjectRequest>): Promise<void> => {
	const { id, files } = event.data;

	try {
		// The shared ts chunk — loaded once, on first use.
		tsApi ??= ((await import("typescript")) as unknown as { "default": TsApi }).default;

		// Recognize with the TS AST, then attach durable BABLR anchors (game-anchors.ts).
		const model = anchorGame(files, recognizeGame(files, tsApi));

		(globalThis as unknown as Worker).postMessage({ "id": id, "model": model });
	} catch (error) {
		(globalThis as unknown as Worker).postMessage({ "id": id, "error": error instanceof Error ? error.message : String(error) });
	}
};
