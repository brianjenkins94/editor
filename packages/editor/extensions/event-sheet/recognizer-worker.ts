/**
 * The recognizer, in a worker the event-sheet extension starts — the game's files in, its GameModel out — so parsing
 * doesn't block the extension host.
 *
 * It needs a `typescript` to parse, so it's built with the LSP workers (build.ts), where `typescript` is one shared chunk:
 * this references the editor's ts rather than bundling a second copy, and loads it on the first request.
 *
 * Its extension asks over the worker's own channel: `{ id, files }` → `{ id, model }` or `{ id, error }`. It's started
 * through a one-line bootstrap that imports this module (an extension's workers start classic), so it says `{ ready }`
 * once it listens: a request sent before then would be lost.
 */
import type { TsApi } from "./recognizer";
import { recognizeGame } from "./recognizer";

let tsApi: TsApi | undefined;

globalThis.addEventListener("message", (event: MessageEvent) => {
	const { id, files } = event.data as { "id": number; "files": Record<string, string> };

	void (async () => {
		try {
			// The shared ts chunk — loaded once, on first use.
			tsApi ??= ((await import("typescript")) as unknown as { "default": TsApi }).default;
			// Recognize with the TS AST; the extension attaches the durable BABLR anchors (anchors.ts), from the editor's BABLR.
			globalThis.postMessage({ "id": id, "model": recognizeGame(files, tsApi) });
		} catch (error) {
			globalThis.postMessage({ "id": id, "error": error instanceof Error ? error.message : String(error) });
		}
	})();
});

globalThis.postMessage({ "ready": true });
