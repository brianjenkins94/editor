/*! coi-serviceworker — cross-origin isolation for static hosts (e.g. GitHub Pages).
 *
 * The workbench needs SharedArrayBuffer, which requires the page to be crossOriginIsolated
 * (Cross-Origin-Opener-Policy: same-origin + a Cross-Origin-Embedder-Policy). A dev server sets those
 * headers directly (vite.config.ts coi-headers), but a static host can't — so this worker stamps them
 * onto every response instead. COEP is `credentialless` (not require-corp) so the CDN node_modules
 * overlay's cross-origin unpkg fetches, which carry no CORP header, keep working.
 *
 * Registered by coi.ts, which reloads once so the worker controls the page. Pattern adapted from
 * github.com/gzuidhof/coi-serviceworker (MIT). Plain JS (served from public/ untouched by vite).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	const request = event.request;

	// A range/only-if-cached cross-origin request can't be re-fetched here — leave it to the browser.
	if (request.cache === "only-if-cached" && request.mode !== "same-origin") { return; }

	event.respondWith(fetch(request).then((response) => {
		// Opaque responses (status 0, no-cors) can't have headers added — pass them through untouched.
		if (response.status === 0) { return response; }

		const headers = new Headers(response.headers);

		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");

		return new Response(response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
	}).catch((error) => {
		console.error("[coi-serviceworker]", error);

		return Promise.reject(error);
	}));
});
