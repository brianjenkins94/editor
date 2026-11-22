export function ensureCrossOriginIsolated(): boolean {
	const isolated = globalThis.crossOriginIsolated;

	if (!globalThis.isSecureContext || navigator.serviceWorker === undefined) {
		return true;
	}

	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";
	const { controller } = navigator.serviceWorker;
	const strict = controller?.scriptURL.includes("coep=require-corp") === true;
	const switching = !isolated && controller !== null && !strict;
	const exhausted = !isolated && controller !== null && strict;

	navigator.serviceWorker.register(base + "coi-serviceworker.js" + (strict || switching ? "?coep=require-corp" : ""), { "type": "module" }).then((registration) => {
		if (isolated || exhausted) {
			return;
		}

		if (switching) {
			navigator.serviceWorker.addEventListener("controllerchange", () => {
				location.reload();
			}, { "once": true });

			return;
		}

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

	return isolated || exhausted;
}
