const ACTIVE_WITHIN_MS = 5000;

let registering: Promise<unknown> | undefined;

export async function serviceWorkerActive(): Promise<void> {
	if (registering === undefined) {
		return;
	}

	const failed = registering.then(() => new Promise<never>(() => { /* ready says when */ }), () => undefined);

	await Promise.race([navigator.serviceWorker.ready, failed, new Promise((resolve) => {
		setTimeout(resolve, ACTIVE_WITHIN_MS);
	})]);
}

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

	const registered = navigator.serviceWorker.register(base + "coi-serviceworker.js" + (strict || switching ? "?coep=require-corp" : ""), { "type": "module" });

	registering = registered;
	registered.then((registration) => {
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
