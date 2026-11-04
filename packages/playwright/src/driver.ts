/**
 * A driver for a page whose window is in reach — the same realm, or same-origin, as a preview's frame is to the shell:
 * each op runs on its document at once (engine.ts `run`).
 */
import type { Driver } from "./locator.ts";
import { run } from "./engine.ts";

/** How long a navigation has to load: under what asks for it over the hub (editor-api's `playwright`), so it's this says why. */
const GOTO_TIMEOUT_MS = 50_000;

/** The page in `window` (a getter, when the frame's window changes as it navigates). */
export function windowDriver(window: Window | (() => Window)): Driver {
	const current = (): Window => (typeof window === "function" ? window() : window);

	return {
		"run": async (op) => run(current().document, op),
		"goto": async (url) => {
			const target = current();
			const before = target.document;
			const from = new URL(target.location.href);
			const to = new URL(url, from);

			from.hash = to.hash;

			const sameDocument = from.href === to.href && new URL(url, target.location.href).hash !== "";

			target.location.href = to.href;

			if (sameDocument) {
				return;
			}

			// Its document changing, and that one loaded. (Not `load`: a navigation replaces the window a listener is on, so
			// one on it never hears.)
			const deadline = Date.now() + GOTO_TIMEOUT_MS;

			while (current().document === before || current().document.readyState !== "complete") {
				if (Date.now() > deadline) {
					throw new Error(`page.goto: ${to.href} hadn't loaded after ${String(GOTO_TIMEOUT_MS)} ms`);
				}

				await new Promise((resolve) => {
					setTimeout(resolve, 50);
				});
			}
		},
		"url": async () => current().location.href,
		"title": async () => current().document.title
	};
}
