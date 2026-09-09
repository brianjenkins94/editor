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
	if (globalThis.crossOriginIsolated) { return true; }   // already isolated — dev headers, or reloaded under the SW

	// No secure context / no service worker → we can't isolate here; let the caller try anyway (a dev
	// server may still be supplying the headers, and there's nothing more we can do on an old browser).
	if (!globalThis.isSecureContext || navigator.serviceWorker === undefined) { return true; }

	const base = (import.meta as unknown as { "env"?: { "BASE_URL"?: string } }).env?.BASE_URL ?? "/";

	void navigator.serviceWorker.register(base + "coi-serviceworker.js").then((registration) => {
		// A newly-installing worker → reload once it's ready so this page loads under its control.
		registration.addEventListener("updatefound", () => { location.reload(); });
		// Already active from a prior visit but not yet controlling this load → reload to gain control.
		if (registration.active !== null && navigator.serviceWorker.controller === null) { location.reload(); }
	}).catch((error: unknown) => { console.error("[coi] service worker registration failed", error); });

	return false;   // a reload is (or will be) scheduled; don't boot this load
}
