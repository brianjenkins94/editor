/**
 * The terminal's `vite` command — starts the live preview. Real Vite (native esbuild, Rollup, a Node process)
 * can't run in the browser, so a project's `dev` script (`"dev": "vite"`) maps here: it asks the host to open
 * the preview pane, whose dev server is almostnode's ViteDevServer running in the node worker on the shared
 * workspace (see preview.ts / node-worker.ts). `npm run dev` composes onto this through the shell.
 */
import { defineCommand } from "just-bash/browser";
import type { CustomCommand } from "just-bash/browser";

/** The `vite` command. `openPreview` signals the host page to open the preview on the given root. */
export function createViteCommand(openPreview: (root: string) => void): CustomCommand {
	return defineCommand("vite", async (_args, ctx) => {
		openPreview(ctx.cwd);

		return {
			"stdout": `\n  [32m➜[0m  Live preview opened — dev server running in the worker on ${ctx.cwd}\n  [32m➜[0m  Edit a file and save; the preview hot-reloads (React Fast Refresh).\n\n`,
			"stderr": "",
			"exitCode": 0
		};
	});
}
