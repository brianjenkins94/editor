/*! coi-serviceworker — cross-origin isolation + same-origin module resolver + dev-server bridge for the editor.
 *
 * The workbench needs SharedArrayBuffer, which requires the page to be crossOriginIsolated
 * (Cross-Origin-Opener-Policy: same-origin + a Cross-Origin-Embedder-Policy). A dev server sets those
 * headers directly (vite.config.ts coi-headers), but a static host can't — so this worker stamps them
 * onto every response instead. COEP is `credentialless` (not require-corp) so the cross-origin CDN fetch
 * below, whose response carries no CORP header, keeps working — except in WebKit, which has no credentialless:
 * there coi.ts registers this worker with `?coep=require-corp`, and that is what it stamps.
 *
 * ONE service worker owns two roles, over one path space and with no magic module namespaces:
 *   • node_modules resolver — for a request under /workspace/node_modules/, it fetches the package from the CDN
 *     internally and hands it back same-origin (the fold-in that RETIRED the old `__proxy__` route — the worker's
 *     own fetch follows the CDN's unversioned 302s and isn't bound by the document's COEP), so go-to-definition
 *     and runtime type acquisition can read dep source over ordinary fetch. Any other /workspace/ request falls
 *     through to the network, so the resolver only ADDS node_modules serving. The real workspace SOURCE is NOT
 *     served here: the editor, type-checker and LSP workers read it through the zen-fs FileSystemProvider (and
 *     the shared SharedArrayBuffer, see workspace-fs.ts / zenfs-vfs.ts) — so the old IndexedDB "vfs store" serving
 *     path was retired.
 *   • COI stamping — every other response is passed through with the isolation headers added.
 *
 * Registered by coi.ts (in prod to provide isolation; in dev, additionally, for the resolver). Pattern
 * adapted from github.com/gzuidhof/coi-serviceworker (MIT). Bundled as an ES MODULE (sw.config.ts) so it can
 * import the hub below; registered {type:module} (coi.ts / server-bridge.ts).
 */
import { createHub, portTransport } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { NETWORK_PROBES } from "./shared/architecture";

// The SW is a first-class hub node. Its otherwise-invisible lifecycle (CDN fallbacks, dev-server relays,
// errors) is recorded through a source-scoped logger whose records — timed SPANS included — ride the hub to
// the page's `$sys.log.>` collector. It links to the page over a DEDICATED hub port (the {type:"hub"} message
// below). Standalone until linked — records just drop, by design.
//
// The SW holds NO state worth keeping: the browser stops an idle one and starts a fresh global on the next event,
// so everything it needs is asked for per request (over the hub) and nothing is remembered between them.
//
// One SW serves EVERY tab of the origin, and each tab's root hub links to it. Those links are non-transit: tabs are
// never joined through the SW.
const swHub = createHub({ "id": "sw" });
// Its logs and uncaught errors, and its hub + upstream requests (CDN) on $sys.arch.
const { "log": swLog } = observe(swHub, { "network": NETWORK_PROBES });

// Anything else: fetched, isolation-stamped. A request that fails on the network (offline, a host that doesn't answer,
// the page going away) is a network error for the page either way: answered as one, rather than a rejection respondWith
// leaves uncaught here — which the editor would report as an error of its own.
async function passThrough(request) {
	return fetch(request).then(stamp).catch((error) => {
		console.warn("[coi-serviceworker] network error:", request.url, String(error));

		return Response.error();
	});
}

// ── node_modules resolver (CDN fallback) ──────────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = "/workspace/";                 // requests here resolve deps against node_modules → CDN
const NODE_MODULES = "/workspace/node_modules/";      // where bare specifiers resolve; CDN-fallback on a miss
const CDN = "https://unpkg.com";                      // node_modules miss → fetched here, served same-origin
// /workspace/ (WORKSPACE_ROOT) is recognised under ANY deploy-base prefix — on GitHub Pages the SW is scoped to /editor/.

// Split a node_modules-relative path ("<pkg>/<sub>" or "<pkg>") into package + subpath, honouring scopes.
function splitPackage(rel) {
	const at = rel[0] === "@" ? rel.indexOf("/", rel.indexOf("/") + 1) : rel.indexOf("/");

	return { "pkg": at === -1 ? rel : rel.slice(0, at), "sub": at === -1 ? "" : rel.slice(at + 1) };
}

// The COEP this worker stamps: `credentialless`, or `require-corp` where the browser doesn't take credentialless
// (WebKit), as coi.ts registers it then (`?coep=require-corp`): the one Safari isolates with.
const COEP = new URL(globalThis.location.href).searchParams.get("coep") === "require-corp" ? "require-corp" : "credentialless";

// Statuses whose Response must not carry a body.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

// Add cross-origin isolation headers to a response (opaque responses can't be modified — pass them through). A
// null-body status (204, 304…) gets no body: WebKit hands one over (empty) and then refuses it in a new Response.
function stamp(response) {
	if (response.status === 0) {
		return response;
	}

	const headers = new Headers(response.headers);

	headers.set("Cross-Origin-Embedder-Policy", COEP);
	headers.set("Cross-Origin-Opener-Policy", "same-origin");

	return new Response(NULL_BODY.has(response.status) ? null : response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
}

// CDN fallback for a node_modules store miss (the fold-in that retired `__proxy__`). Reconstruct the CDN URL
// from the real path + `?v=` (pinned version) + `?meta` (directory listing), fetch it here — the worker's own
// fetch follows the CDN's unversioned 302 and isn't bound by the document's COEP — and hand it back
// same-origin. Serves RAW source (no import rewrite): the consumer is go-to-definition, which shows real dep
// source. Keep in sync with vite.ts nodeModulesCdnPlugin (the dev mirror).
// Whether the CDN answers for `pkg@version` at all (its package.json comes with CORS), asked once per version: what
// tells a missing file from an unreachable CDN.
const answering = new Map();

function packageAnswers(pinned) {
	if (!answering.has(pinned)) {
		answering.set(pinned, fetch(CDN + "/" + pinned + "/package.json").then((response) => response.ok, () => {
			answering.delete(pinned); // unreachable now: ask again next time

			return false;
		}));
	}

	return answering.get(pinned);
}

async function fetchCdn(pathname, requestUrl) {
	const { pkg, sub } = splitPackage(pathname.slice(NODE_MODULES.length));
	const meta = requestUrl.searchParams.has("meta");
	let version = requestUrl.searchParams.get("v");
	let spec = pkg + (version === null ? "" : "@" + version) + (sub === "" ? "" : "/" + sub);
	// A timed span: the collector shows `→ cdn` / `← cdn (Xms)`, so a slow/failed CDN fallback is visible.
	const span = swLog.span("editor.coi-serviceworker.cdn", { "spec": spec });

	try {
		// unpkg's redirect for an UNVERSIONED `?meta` carries no CORS header (its file redirects do), so this fetch would
		// fail on it: pin the version from the package's package.json first.
		if (meta && version === null) {
			version = (await (await fetch(CDN + "/" + pkg + "/package.json")).json()).version ?? null;
			spec = pkg + (version === null ? "" : "@" + version) + (sub === "" ? "" : "/" + sub);
		}

		const response = await fetch(CDN + "/" + spec + (meta ? "?meta" : ""));
		const headers = new Headers(response.headers);

		headers.set("Cross-Origin-Embedder-Policy", COEP);
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Cross-Origin-Resource-Policy", "cross-origin");

		span.end({ "status": response.status });

		return new Response(response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
	} catch (error) {
		// unpkg's 404 carries no CORS header either, so a file that isn't there (tsserver probing `react/index.d.ts`,
		// whose types live in @types/react) throws here like an outage would. If the package itself answers, the CDN
		// is up and the file is missing: say 404, which the node_modules provider caches, rather than a 502 it retries.
		if (version !== null && await packageAnswers(pkg + "@" + version)) {
			span.end({ "status": 404 });

			return new Response("not found", { "status": 404, "statusText": "Not Found" });
		}

		console.error("[coi-serviceworker] cdn", spec, error);
		span.error("cdn failed", { "spec": spec, "error": String(error) });
		span.end();

		return new Response("cdn error", { "status": 502, "statusText": "Bad Gateway" });
	}
}

// Resolver: a request under /workspace/node_modules/ resolves the dep from the CDN (served same-origin); any
// other /workspace/ request passes through to the network, isolation-stamped — so this only ADDS serving of
// node_modules and can't break a fetch. (The editor + type-checker + LSP workers read the real workspace files
// through the zen-fs FileSystemProvider / shared SharedArrayBuffer, not through the SW. So the SW no longer serves
// workspace source — only the node_modules CDN fold-in remains.)
async function serveWorkspace(request, requestUrl, pathname) {
	if (pathname.startsWith(NODE_MODULES)) {
		return fetchCdn(pathname, requestUrl);
	}

	return stamp(await fetch(request));   // non-node_modules /workspace/ → network, isolation-stamped
}

// The hub link to each tab's root, by window client id (a tab relinking replaces its own; a closed tab's is dropped).
const tabLinks = new Map();

async function linkTab(clientId, port) {
	tabLinks.get(clientId)?.();
	tabLinks.set(clientId, swHub.link(portTransport(port), { "transit": false }));

	for (const id of [...tabLinks.keys()]) {
		if (id !== clientId && !(await globalThis.clients.get(id))) {
			tabLinks.get(id)();
			tabLinks.delete(id);
		}
	}
}

globalThis.addEventListener("message", (event) => {
	const data = event.data;

	// Dedicated observability link: the page hands us a hub port (observability's linkServiceWorkerHub). Link our
	// hub over it so `$sys.log.sw` records federate to the page's collector.
	if (data && data.type === "hub" && event.ports && event.ports[0]) {
		void linkTab(event.source && event.source.id, event.ports[0]).then(() => {
			swLog.info("hub linked", { "tabs": tabLinks.size });
		});
	}
});

// The browser stops an idle service worker and starts a FRESH one on the next event — a new global, whose hub no
// page has linked (the page only relinks on controllerchange, which a restart doesn't fire). Unlinked, the SW
// drops out of the tree: its logs and architecture reports vanish. So on every start, ask the window clients for a hub port
// (only the app realm's linkServiceWorkerHub answers; a first install gets linked twice, harmlessly).
void globalThis.clients.matchAll({ "type": "window" }).then((clients) => {
	for (const client of clients) {
		client.postMessage({ "type": "sw-needs-hub" });
	}
});

globalThis.addEventListener("fetch", (event) => {
	const request = event.request;
	const requestUrl = new URL(request.url);
	const pathname = requestUrl.pathname;

	// Module resolver: <base>/workspace/… (store + node_modules CDN fallback). Strip any base prefix so the
	// logical /workspace/… path keys the store and reconstructs the CDN URL.
	const wsIndex = pathname.indexOf(WORKSPACE_ROOT);

	if (wsIndex !== -1) {
		event.respondWith(serveWorkspace(request, requestUrl, pathname.slice(wsIndex)));

		return;
	}

	// A range/only-if-cached cross-origin request can't be re-fetched here — leave it to the browser.
	if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
		return;
	}

	// Everything else passes straight through with COI stamping.
	event.respondWith(passThrough(request));
});
