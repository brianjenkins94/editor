/**
 * Reverse-projection worker — runs the game recognizer OFF the main thread, where TypeScript is loaded.
 *
 * WHY a worker: the recognizer needs a `typescript` to parse. Importing ts into the main workbench bundle would add
 * ~7MB to main.js. Built in build.ts pass 2 (alongside the LSP workers, with `dedupe:["typescript"]` + the manualChunks
 * that force ONE shared `lsp/typescript` chunk), this worker REFERENCES that same chunk — the editor's ts, not a second
 * bundled copy. ts is dynamic-imported LAZILY on the first request, so spawning the worker stays cheap.
 *
 * Served over the hub: `recognizer.project` { files } → a plain-JSON GameModel. Driven by game-projection.ts in the
 * workbench realm.
 */
import { serve } from "@brianjenkins94/hub";

import type { TsApi } from "./game-recognizer";
import { anchorGame } from "./game-anchors";
import { recognizeGame } from "./game-recognizer";
import { createWorkerHub } from "./worker-hub";

const hub = createWorkerHub("recognizer");
let tsApi: TsApi | undefined;

serve(hub, "recognizer.project", async (args) => {
	const { files } = args as { "files": Record<string, string> };

	// The shared ts chunk — loaded once, on first use.
	tsApi ??= ((await import("typescript")) as unknown as { "default": TsApi }).default;

	// Recognize with the TS AST, then attach durable BABLR anchors (game-anchors.ts).
	return anchorGame(files, recognizeGame(files, tsApi));
});
