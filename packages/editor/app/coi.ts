/**
 * Cross-origin isolation for static hosts. The workbench needs SharedArrayBuffer, which requires the
 * page to be crossOriginIsolated (COOP: same-origin + COEP). A dev server sets those headers directly
 * (vite.config.ts coi-headers), but GitHub Pages can't — so a service worker (public/coi-serviceworker.js)
 * stamps them onto every response instead. On the first, un-isolated load we register the worker and,
 * once it controls the page, reload so this load is isolated; the reloaded page then boots normally.
 *
 * The worker stamps COEP `credentialless`, which WebKit (Safari) doesn't take. A load the worker controls that still
 * isn't isolated is that case: we register it again as `?coep=require-corp` (the worker then stamps that, which
 * Safari does isolate with) and reload once it takes over. The registration remembers the choice, so later loads keep
 * it. And a load that isn't isolated even then boots anyway, without SharedArrayBuffer, rather than never.
 */

/** Whether the caller may boot now. `true` once the page is isolated (dev headers, or a reload has come
 *  back under the service worker's control), or once isolating has been tried every way; `false` when a reload has
 *  just been scheduled to gain isolation — the caller should not boot this load. */
export function ensureCrossOriginIsolated(): boolean {
	const isolated = globalThis.crossOriginIsolated;

	// Boot now if we can't isolate at all (no SW/secure context — a dev server may still supply headers).
	if (!globalThis.isSecureContext || navigator.serviceWorker === undefined) {
		return true;
	}

	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";
	const { controller } = navigator.serviceWorker;
	const strict = controller?.scriptURL.includes("coep=require-corp") === true;
	// Controlled but not isolated: credentialless didn't take (WebKit) — try require-corp; if that's what didn't take,
	// stop trying.
	const switching = !isolated && controller !== null && !strict;
	const exhausted = !isolated && controller !== null && strict;

	// Register the service worker whenever we can. In PRODUCTION it PROVIDES isolation (a static host can't
	// set COOP/COEP headers, so the worker stamps them). In DEV the vite server already sets those headers,
	// but we still register the worker so its same-origin node_modules resolver (CDN fold-in for go-to-def /
	// type acquisition; see coi-serviceworker.js) and dev-server bridge are active. Registration can fail
	// (e.g. an embedded browser that blocks service workers) — that's harmless when headers already isolate.
	// {type:module}: the SW is now a bundled ES module (it imports @brianjenkins94/hub — see sw.config.ts).
	navigator.serviceWorker.register(base + "coi-serviceworker.js" + (strict || switching ? "?coep=require-corp" : ""), { "type": "module" }).then((registration) => {
		if (isolated || exhausted) {
			return;   // isolated already (headers, or the worker), or not possible here: the worker just attaches for the resolver
		}

		// The require-corp worker replaces this one (it skips waiting and claims the page): reload once it has.
		if (switching) {
			navigator.serviceWorker.addEventListener("controllerchange", () => {
				location.reload();
			}, { "once": true });

			return;
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

	if (exhausted) {
		console.warn("[coi] not cross-origin isolated under the service worker: booting without SharedArrayBuffer");
	}

	// Only a pending reload returns false.
	return isolated || exhausted;
}
