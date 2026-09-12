/**
 * Cross-origin isolation for static hosts. The workbench needs SharedArrayBuffer, which requires the
 * page to be crossOriginIsolated (COOP: same-origin + COEP). A dev server sets those headers directly
 * (vite.config.ts coi-headers), but GitHub Pages can't — so a service worker (public/coi-serviceworker.js)
 * stamps them onto every response instead. On the first, un-isolated load we register the worker and,
 * once it controls the page, reload so this load is isolated; the reloaded page then boots normally.
 */

/** Whether the caller may boot now. `true` once the page is isolated (dev headers, or a reload has come
 *  back under the service worker's control); `false` when a reload has just been scheduled to gain
 *  isolation — the caller should not boot this load. */
export function ensureCrossOriginIsolated(): boolean {
	const isolated = globalThis.crossOriginIsolated;

	// Register the service worker whenever we can. In PRODUCTION it PROVIDES isolation (a static host can't
	// set COOP/COEP headers, so the worker stamps them). In DEV the vite server already sets those headers,
	// but we still register the worker so its same-origin module resolver (serving the VFS store; see vfs.ts)
	// is active. Registration can fail (e.g. an embedded browser that blocks service workers) — that's
	// harmless when headers already isolate: we just don't get the resolver on that load.
	if (globalThis.isSecureContext && navigator.serviceWorker !== undefined) {
		const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";

		// {type:module}: the SW is now a bundled ES module (it imports @brianjenkins94/hub — see sw.config.ts).
			navigator.serviceWorker.register(base + "coi-serviceworker.js", { "type": "module" }).then((registration) => {
			if (isolated) {
				return;   // headers already isolate this load; the worker just attaches for the resolver — no reload
			}

			// Not isolated (static host): reload once the worker controls the page so this load gains isolation.
			registration.addEventListener("updatefound", () => {
				location.reload();
			});
			if (registration.active !== null && navigator.serviceWorker.controller === null) {
				location.reload();
			}
		}).catch((error: unknown) => {
			console.error("[coi] service worker registration failed", error);
		});
	}

	// Boot now if we're already isolated (dev headers) or can't isolate at all (no SW/secure context — a dev
	// server may still supply headers). Only a pending prod reload returns false.
	return isolated || !globalThis.isSecureContext || navigator.serviceWorker === undefined;
}
