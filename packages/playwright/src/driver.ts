/**
 * A driver for a page whose window is in reach — the same realm, or same-origin, as a preview's frame is to the shell:
 * each op runs on its document at once (engine.ts `run`).
 */
import type { Driver } from "./locator.ts";
import { run } from "./engine.ts";

/** The page in `window` (a getter, when the frame's window changes as it navigates). */
export function windowDriver(window: Window | (() => Window)): Driver {
	const current = (): Window => (typeof window === "function" ? window() : window);

	return {
		"run": async (op) => run(current().document, op),
		"goto": async (url) => {
			const target = current();
			const loaded = new Promise<void>((resolve) => {
				target.addEventListener("load", () => {
					resolve();
				}, { "once": true });
			});

			target.location.href = new URL(url, target.location.href).href;
			await loaded;
		},
		"url": async () => current().location.href,
		"title": async () => current().document.title
	};
}
