/**
 * The terminal's `vite` command — starts the live preview and behaves like a real dev server: it opens the
 * preview pane (its dev server is almostnode's ViteDevServer in the node worker — real Vite can't run in the
 * browser), then BLOCKS, streaming HMR activity as log lines, until Ctrl-C, which stops the dev server and
 * closes the pane. A project's `dev` script (`"dev": "vite"`) maps here, so `npm run dev` composes onto it.
 */
import type { CustomCommand } from "just-bash/browser";
import { defineCommand } from "just-bash/browser";

import type { NodeOutput, NodeRunner } from "./node-runner";

// Must match preview.ts's PREVIEW_PORT — the port the dev server and its HMR channel are namespaced on.
const PREVIEW_PORT = 5173;

/** `HH:MM:SS`, dev-server log style. */
function stamp(): string {
	return new Date().toLocaleTimeString("en-US", { "hour12": false });
}

/** The `vite` command. `runner` drives the worker preview; `writeLive` streams to the terminal as it runs. */
export function createViteCommand(runner: NodeRunner, writeLive: NodeOutput): CustomCommand {
	return defineCommand("vite", async (_args, ctx) => {
		runner.openPreview(ctx.cwd);
		writeLive("out", `\n  [1m[35mVITE[0m  dev server ready [2m(in the worker, on ${ctx.cwd})[0m\n\n  [32m➜[0m  Preview:  opened the Preview pane\n  [2m➜  press Ctrl-C to stop[0m\n\n`);

		// Stream HMR activity as dev-server-style log lines while we block.
		const off = runner.onPreviewHmr(PREVIEW_PORT, (message) => {
			const update = message as { "type"?: string; "path"?: string };
			const kind = update.type === "full-reload" ? "page reload" : "hmr update";

			writeLive("out", `  [2m${stamp()}[0m [36m[vite][0m ${kind} [2m${update.path ?? ""}[0m\n`);
		});

		// Block like a real dev server until the shell's Ctrl-C aborts us (the signal is forwarded through
		// `npm run dev` too — see terminal-npm.ts).
		await new Promise<void>((resolve) => {
			if (ctx.signal?.aborted === true) {
				resolve();

				return;
			}

			ctx.signal?.addEventListener("abort", () => { resolve(); }, { "once": true });
		});

		off();
		runner.closePreview();
		writeLive("out", "\n  [2mvite: dev server stopped[0m\n");

		return { "stdout": "", "stderr": "", "exitCode": 130 };
	});
}
