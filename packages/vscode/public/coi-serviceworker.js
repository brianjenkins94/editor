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
globalThis.addEventListener("install", () => globalThis.skipWaiting());
globalThis.addEventListener("activate", (event) => event.waitUntil(globalThis.clients.claim()));

globalThis.addEventListener("fetch", (event) => {
	const request = event.request;

	// __proxy__ — same-origin CDN proxy (mirrors proxy.ts; the SW can't import it, so the segment +
	// reconstruction are inlined — keep in sync). A same-origin request `<…>/__proxy__/<host>/<path>` is
	// the node_modules overlay reaching a CDN. We fetch the real https URL here: a SW fetch isn't bound by
	// the document's COEP and follows redirects internally (so unpkg's unversioned 302, which lacks CORS,
	// still resolves), then we hand it back as a same-origin, isolation-friendly resource.
	const requestUrl = new URL(request.url);
	const proxyMarker = "/__proxy__/";
	const proxyIndex = requestUrl.pathname.indexOf(proxyMarker);

	if (proxyIndex !== -1) {
		const realUrl = "https://" + requestUrl.pathname.slice(proxyIndex + proxyMarker.length) + requestUrl.search;

		event.respondWith(fetch(realUrl).then((response) => {
			const headers = new Headers(response.headers);

			headers.set("Cross-Origin-Embedder-Policy", "credentialless");
			headers.set("Cross-Origin-Opener-Policy", "same-origin");
			headers.set("Cross-Origin-Resource-Policy", "cross-origin");

			return new Response(response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
		}).catch((error) => {
			console.error("[coi-serviceworker] proxy", realUrl, error);

			return new Response("proxy error", { "status": 502, "statusText": "Bad Gateway" });
		}));

		return;
	}

	// A range/only-if-cached cross-origin request can't be re-fetched here — leave it to the browser.
	if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
		return;
	}

	event.respondWith(fetch(request).then((response) => {
		// Opaque responses (status 0, no-cors) can't have headers added — pass them through untouched.
		if (response.status === 0) {
			return response;
		}

		const headers = new Headers(response.headers);

		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");

		return new Response(response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
	}).catch((error) => {
		console.error("[coi-serviceworker]", error);

		return Promise.reject(error);
	}));
});
