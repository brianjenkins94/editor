/**
 * The terminal's `vite` command — starts the live preview and behaves like a real dev server: it opens the
 * preview pane (its dev server is almostnode's ViteDevServer in the node worker — real Vite can't run in the
 * browser), then BLOCKS, streaming HMR activity as log lines, until Ctrl-C, which stops the dev server and
 * closes the pane. A project's `dev` script (`"dev": "vite"`) maps here, so `npm run dev` composes onto it.
 */
import type { CustomCommand } from "just-bash/browser";
import { defineCommand } from "just-bash/browser";

import type { NodeOutput, NodeRunner } from "./node-runner";

// The first preview port; concurrent `vite` runs (a multi-server app, two packages' dev servers) each claim the
// next free one so their previews, HMR channels and SW port→run attribution never collide.
const BASE_PORT = 5173;
const inUsePorts = new Set<number>();

/** Claim the lowest free preview port (single preview → always 5173). */
function allocatePort(): number {
	let port = BASE_PORT;

	while (inUsePorts.has(port)) {
		port += 1;
	}

	inUsePorts.add(port);

	return port;
}

/** `HH:MM:SS`, dev-server log style. */
function stamp(): string {
	return new Date().toLocaleTimeString("en-US", { "hour12": false });
}

/** The `vite` command. `runner` drives the worker preview; `writeLive` streams to the terminal as it runs. */
export function createViteCommand(runner: NodeRunner, writeLive: NodeOutput, terminal: number): CustomCommand {
	return defineCommand("vite", async (_args, ctx) => {
		// One dev server per directory: a second `vite` here would only start a copy on the next port, unseen beside the
		// first. Say where the first is instead.
		const serving = runner.runs.runningService((run) => run.cwd === ctx.cwd);

		if (serving !== undefined) {
			const where = "terminal" in serving.origin ? ` in terminal ${serving.origin.terminal}` : "";

			return { "stdout": "", "stderr": `vite: ${ctx.cwd} is already being served${serving.port === undefined ? "" : " on :" + serving.port}${where} (${serving.title}) — its preview is open. Stop it there (Ctrl-C), or from the running list, to start it again.\n`, "exitCode": 1 };
		}

		const port = allocatePort(); // its own port + preview window, so concurrent dev servers coexist
		// (`npm run` passes the script's name in the environment it runs it with — ctx.env, not the exported one.)
		const event = Object.fromEntries(ctx.env)["npm_lifecycle_event"] ?? ctx.exportedEnv?.["npm_lifecycle_event"];
		let stop = (): void => { /* set below, once it's blocking */ };
		// A service — it runs until it's stopped — in the running list, as it was asked for (`npm run dev` runs `vite`).
		const run = runner.runs.start({ "title": event === undefined ? "vite" : "npm run " + event, "kind": "service", "cwd": ctx.cwd, "origin": { "terminal": terminal }, "port": port }, () => { stop(); });

		runner.openPreview(ctx.cwd, port);
		// Present the dev server as a VS Code debug session too (the "production" debug mode) — it shows in Run and
		// Debug with a Stop button, not just as a terminal process. Output/lifecycle ride its Debug Console.
		const sessionId = runner.startProductionSession(port === BASE_PORT ? "vite (preview)" : `vite :${port} (preview)`, port, ctx.cwd, run.id);

		runner.emitProductionOutput(sessionId, "out", `VITE dev server ready (on ${ctx.cwd}) — Stop from the debug toolbar or Ctrl-C.\n`);
		writeLive("out", `\n  [1m[35mVITE[0m  dev server ready [2m(in the worker, on ${ctx.cwd})[0m\n\n  [32m➜[0m  Preview:  opened the Preview pane\n  [2m➜  press Ctrl-C to stop[0m\n\n`);

		// Stream HMR activity as dev-server-style log lines while we block.
		const off = runner.onPreviewHmr(port, (message) => {
			const update = message as { "type"?: string; "path"?: string };
			const kind = update.type === "full-reload" ? "page reload" : "hmr update";

			writeLive("out", `  [2m${stamp()}[0m [36m[vite][0m ${kind} [2m${update.path ?? ""}[0m\n`);
		});

		// Block like a real dev server until the shell's Ctrl-C (ctx.signal, also forwarded through `npm run dev` — see
		// terminal-npm.ts), the debug session's Stop button (production.stop), or the server's last preview window
		// closing (which stops the server) — whichever comes first.
		let offStop = (): void => { /* set below */ };
		let offClosed = (): void => { /* set below */ };

		await new Promise<void>((resolve) => {
			if (ctx.signal?.aborted === true) {
				resolve();

				return;
			}

			ctx.signal?.addEventListener("abort", () => { resolve(); }, { "once": true });
			stop = resolve; // the running list's Stop
			offStop = runner.onProductionStop(sessionId, () => { resolve(); });
			offClosed = runner.onPreviewClose(port, () => { resolve(); });
		});

		off();
		offStop();
		offClosed();
		runner.endProductionSession(sessionId);
		runner.closePreview(port);
		inUsePorts.delete(port); // free it for the next run
		run.end(130, true);
		writeLive("out", "\n  [2mvite: dev server stopped[0m\n");

		return { "stdout": "", "stderr": "", "exitCode": 130 };
	});
}
