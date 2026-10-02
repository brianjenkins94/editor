/*! coi-serviceworker — cross-origin isolation + same-origin module resolver + dev-server bridge for the editor.
 *
 * The workbench needs SharedArrayBuffer, which requires the page to be crossOriginIsolated
 * (Cross-Origin-Opener-Policy: same-origin + a Cross-Origin-Embedder-Policy). A dev server sets those
 * headers directly (vite.config.ts coi-headers), but a static host can't — so this worker stamps them
 * onto every response instead. COEP is `credentialless` (not require-corp) so the cross-origin CDN fetch
 * below, whose response carries no CORP header, keeps working.
 *
 * ONE service worker owns three roles, over one path space and with no magic module namespaces:
 *   • node_modules resolver — for a request under /workspace/node_modules/, it fetches the package from the CDN
 *     internally and hands it back same-origin (the fold-in that RETIRED the old `__proxy__` route — the worker's
 *     own fetch follows the CDN's unversioned 302s and isn't bound by the document's COEP), so go-to-definition
 *     and runtime type acquisition can read dep source over ordinary fetch. Any other /workspace/ request falls
 *     through to the network, so the resolver only ADDS node_modules serving. The real workspace SOURCE is NOT
 *     served here: the editor, type-checker and LSP workers read it through the zen-fs FileSystemProvider (and
 *     the shared SharedArrayBuffer, see workspace-fs.ts / zenfs-vfs.ts), and the preview runs its own in-page
 *     dev server — so the old IndexedDB "vfs store" serving path was retired.
 *   • Dev-server bridge — a preview's dev server (almostnode's ViteDevServer) runs in the node worker; we answer
 *     `/__virtual__/<tab>/<port>/…` fetches by calling it over the hub (`virtual.request`), so the preview iframe
 *     reaches it over ordinary HTTP. (This used to be almostnode's ServerBridge: a MessagePort to a relay in the
 *     page. The hub already links us to the page, so the port and the relay are gone.)
 *   • COI stamping — every other response is passed through with the isolation headers added.
 *
 * Registered by coi.ts (in prod to provide isolation; in dev, additionally, for the resolver). Pattern
 * adapted from github.com/gzuidhof/coi-serviceworker (MIT). Bundled as an ES MODULE (sw.config.ts) so it can
 * import the hub below; registered {type:module} (coi.ts / server-bridge.ts).
 */
import { createHub, createRpcClient, portTransport } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { NETWORK_PROBES } from "./architecture";
import { parseVirtual } from "./virtual-path";

// The SW is a first-class hub node. Its otherwise-invisible lifecycle (CDN fallbacks, dev-server relays,
// errors) is recorded through a source-scoped logger whose records — timed SPANS included — ride the hub to
// the page's `$sys.log.>` collector. It links to the page over a DEDICATED hub port (the {type:"hub"} message
// below). Standalone until linked — records just drop, by design.
//
// The SW holds NO state worth keeping: the browser stops an idle one and starts a fresh global on the next event,
// so everything it needs is asked for per request (over the hub) and nothing is remembered between them.
//
// One SW serves EVERY tab of the origin, and each tab's root hub links to it. Those links are non-transit — tabs are
// never joined through the SW — and what the SW asks on a tab's behalf is ADDRESSED to that tab: a preview's URL
// names its tab (/__virtual__/<tab>/<port>/), a node worker names its tab on the decide route, and the SW calls
// `virtual.request.<tab>` / `capability.decide.<tab>`, which only that tab's root answers (from its own tree).
const swHub = createHub({ "id": "sw" });
// Its logs and uncaught errors, and its hub + upstream requests (CDN) on $sys.arch, plus what it serves previews and
// relays to the dev server.
const { "log": swLog, architecture } = observe(swHub, { "network": NETWORK_PROBES });

// The preview a request came from: its own /__virtual__/<tab>/<port>/ URL, else the preview document that asked for it.
async function previewOf(event, pathname) {
	const preview = parseVirtual(pathname) || await previewClientOf(event);

	return preview === undefined ? undefined : "preview:" + preview.port;
}

// A preview's request, as `preview:<port> → sw`, and the SW's answer back to it.
function recordPreviewRequest(event, pathname, label, responsePromise) {
	void previewOf(event, pathname).then((preview) => {
		if (preview === undefined) {
			return;
		}

		architecture.record(preview, architecture.self, "request", event.request.method + " " + label);
		responsePromise.then((response) => {
			architecture.record(architecture.self, preview, response.status >= 400 ? "error" : "reply", response.status + " " + label);
		}, () => {
			architecture.record(architecture.self, preview, "error", "failed " + label);
		});
	});
}

// The capability gate. The SW holds NO policy: it asks the ext host's decision endpoint over the hub — swHub →
// root → workbench → podHub reaches worker-pod's "capability.decide" serve, which owns the popup / grant store /
// redline and resolves a preview's port to the run that owns it — then allows or blocks. It FAILS CLOSED: if no
// decider can be reached (the hub isn't linked yet after a restart and doesn't link within RESPONDER_WAIT_MS, or the
// call errors), the answer is deny. A long timeout, so a deliberating user isn't cut off.
const rpc = createRpcClient(swHub);
const RESPONDER_WAIT_MS = 10000;
const DECIDE = { "timeoutMs": 300000, "waitForResponderMs": RESPONDER_WAIT_MS };

async function decide(call, tab) {
	try {
		return (await rpc.request(tab ? "capability.decide." + tab : "capability.decide", call, DECIDE)) !== false;
	} catch (error) {
		swLog.error("capability.decide unreachable — denying (fail-closed)", { "kind": call && call.kind, "error": String(error) });

		return false;
	}
}

// Capability decision route (fs/exec, from almostnode). A worker's SYNCHRONOUS XHR blocks on this request while
// we run the async decision and reply — the sync-XHR ⇄ SW trick that lets a synchronous shim (writeFileSync) await
// an async popup with no SharedArrayBuffer. Body is the raw CapabilityCall; reply is `{ allow }`.
async function handleCapabilityDecide(request) {
	let call;

	try {
		call = await request.json();
	} catch (error) {
		swLog.error("capability decide route: unreadable call — denying", { "error": String(error) });
	}

	const allow = call !== undefined && await decide(call, new URL(request.url).searchParams.get("tab"));

	return new Response(JSON.stringify({ "allow": allow }), { "headers": { "content-type": "application/json" } });
}

// The preview a request belongs to ({ tab, port }): the /__virtual__/<tab>/<port>/ document that made it (or is
// being navigated to).
async function previewClientOf(event) {
	try {
		const client = await globalThis.clients.get(event.clientId || event.resultingClientId);

		return (client ? parseVirtual(new URL(client.url).pathname) : null) || undefined;
	} catch {
		return undefined;
	}
}

// Gate a previewed app's DATA fetches (destination "" = fetch/XHR, not a subresource/module load) to http(s),
// then fetch or block. Non-preview clients and non-data requests pass straight through — same as before.
async function gateAndFetch(event, request, requestUrl) {
	if (request.destination === "" && (requestUrl.protocol === "https:" || requestUrl.protocol === "http:") && event.clientId) {
		const preview = await previewClientOf(event);

		// A preview client's fetch → gate it, in its tab (the decider attributes it to the run that owns the port).
		if (preview !== undefined && !(await decide({ "kind": "net", "args": [request.url], "port": preview.port }, preview.tab))) {
			return new Response("Blocked by capability policy: net " + requestUrl.host, { "status": 403, "statusText": "Capability denied" });
		}
	}

	return fetch(request).then(stamp).catch((error) => {
		console.error("[coi-serviceworker]", error);

		return Promise.reject(error);
	});
}

globalThis.addEventListener("install", () => globalThis.skipWaiting());
globalThis.addEventListener("activate", (event) => event.waitUntil(globalThis.clients.claim()));

// ── node_modules resolver (CDN fallback) ──────────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = "/workspace/";                 // requests here resolve deps against node_modules → CDN
const NODE_MODULES = "/workspace/node_modules/";      // where bare specifiers resolve; CDN-fallback on a miss
const CDN = "https://unpkg.com";                      // node_modules miss → fetched here, served same-origin
// Dev-server bridge routes (<base>/__virtual__/<tab>/<port>/…) are recognised under ANY deploy-base prefix — on GitHub
// Pages the SW is scoped to /editor/ — by virtual-path.ts's parseVirtual. /workspace/ (WORKSPACE_ROOT) is matched the
// same way below.

// Split a node_modules-relative path ("<pkg>/<sub>" or "<pkg>") into package + subpath, honouring scopes.
function splitPackage(rel) {
	const at = rel[0] === "@" ? rel.indexOf("/", rel.indexOf("/") + 1) : rel.indexOf("/");

	return { "pkg": at === -1 ? rel : rel.slice(0, at), "sub": at === -1 ? "" : rel.slice(at + 1) };
}

// Add cross-origin isolation headers to a response (opaque responses can't be modified — pass them through).
function stamp(response) {
	if (response.status === 0) {
		return response;
	}

	const headers = new Headers(response.headers);

	headers.set("Cross-Origin-Embedder-Policy", "credentialless");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");

	return new Response(response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
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
	const span = swLog.span("cdn", { "spec": spec });

	try {
		// unpkg's redirect for an UNVERSIONED `?meta` carries no CORS header (its file redirects do), so this fetch would
		// fail on it: pin the version from the package's package.json first.
		if (meta && version === null) {
			version = (await (await fetch(CDN + "/" + pkg + "/package.json")).json()).version ?? null;
			spec = pkg + (version === null ? "" : "@" + version) + (sub === "" ? "" : "/" + sub);
		}

		const response = await fetch(CDN + "/" + spec + (meta ? "?meta" : ""));
		const headers = new Headers(response.headers);

		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
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
// through the zen-fs FileSystemProvider / shared SharedArrayBuffer, not through the SW; the preview runs its own
// in-page dev server. So the SW no longer serves workspace source — only the node_modules CDN fold-in remains.)
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
		void linkTab(event.source && event.source.id, event.ports[0]).then(() => { swLog.info("hub linked", { "tabs": tabLinks.size }); });
	}
});

// The browser stops an idle service worker and starts a FRESH one on the next event — a new global, whose hub no
// page has linked (the page only relinks on controllerchange, which a restart doesn't fire). Unlinked, the SW
// drops out of the tree: its logs and architecture reports vanish, and neither capability.decide nor the preview's
// dev servers can be reached (so every preview request fails and the gate denies). So on every start, ask the window clients for a hub port
// (only the app realm's linkServiceWorkerHub answers; a first install gets linked twice, harmlessly).
void globalThis.clients.matchAll({ "type": "window" }).then((clients) => {
	for (const client of clients) {
		client.postMessage({ "type": "sw-needs-hub" });
	}
});

// Add the isolation + iframe-embedding headers a virtual (dev-server) response needs — and the JS Self-Profiling policy,
// so the editor can profile a preview's page (preview-profile.ts): a Profiler can be made only in a document served
// with it.
function virtualHeaders(source) {
	const headers = new Headers(source || {});

	headers.set("Document-Policy", "js-profiling");
	headers.set("Cross-Origin-Embedder-Policy", "credentialless");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	headers.delete("X-Frame-Options");

	return headers;
}

// Statuses whose Response must not carry a body.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

// Answer one request from the dev server on `port` (in the node worker, over the hub). Buffered: the dev server
// answers whole responses (an SSE / chunked API route arrives in one piece).
async function handleVirtualRequest(request, tab, port, path) {
	// A timed span per request — the collector shows each dev-server round-trip and its duration.
	const span = swLog.span("virtual", { "tab": tab, "port": port, "method": request.method, "path": path });

	try {
		const headers = {};

		request.headers.forEach((value, key) => {
			headers[key] = value;
		});

		const body = request.method !== "GET" && request.method !== "HEAD" ? new Uint8Array(await request.arrayBuffer()) : undefined;
		// A worker's ENTRY script (its imports are mode "cors"): the dev server puts the editor's worker tap first.
		const entry = (request.destination === "worker" || request.destination === "sharedworker") && request.mode === "same-origin" ? request.destination : undefined;
		const response = await rpc.request("virtual.request." + tab, { "port": port, "method": request.method, "url": path, "headers": headers, "body": body, "entry": entry }, { "timeoutMs": 30000, "waitForResponderMs": RESPONDER_WAIT_MS });
		const content = NULL_BODY.has(response.status) || request.method === "HEAD" ? null : response.body;

		span.end({ "status": response.status });

		return new Response(content, { "status": response.status, "statusText": response.statusText, "headers": virtualHeaders(response.headers) });
	} catch (error) {
		console.error("[coi-serviceworker] virtual", error);
		span.error("dev server unreachable", { "error": String(error) });
		span.end();

		return new Response("dev server unreachable: " + error.message, { "status": 502, "headers": { "content-type": "text/plain" } });
	}
}

globalThis.addEventListener("fetch", (event) => {
	const request = event.request;
	const requestUrl = new URL(request.url);
	const pathname = requestUrl.pathname;

	// Capability decision route: a worker's blocking sync-XHR asks here (fs/exec gate). Matched by substring so it
	// works under any base prefix, same as the virtual marker below.
	if (pathname.indexOf("/__capability__/decide") !== -1) {
		event.respondWith(handleCapabilityDecide(request));

		return;
	}

	// Dev-server bridge: <base>/__virtual__/<tab>/<port>/…
	const virtual = parseVirtual(pathname);

	if (virtual !== undefined) {
		const response = handleVirtualRequest(request, virtual.tab, virtual.port, (virtual.rest || "/") + requestUrl.search);

		recordPreviewRequest(event, pathname, virtual.rest || "/", response);
		event.respondWith(response);

		return;
	}

	// Module resolver: <base>/workspace/… (store + node_modules CDN fallback). Strip any base prefix so the
	// logical /workspace/… path keys the store and reconstructs the CDN URL.
	const wsIndex = pathname.indexOf(WORKSPACE_ROOT);

	if (wsIndex !== -1) {
		event.respondWith(serveWorkspace(request, requestUrl, pathname.slice(wsIndex)));

		return;
	}

	// A SAME-ORIGIN request with no /__virtual__ segment but a referer from a virtual page — the app used an
	// absolute path or navigated. Keep it inside its server: redirect navigations (re-add the prefix), forward
	// subresources. Origin-guarded so cross-origin CDN imports (react from esm.sh) are never hijacked.
	if (requestUrl.origin === globalThis.location.origin && request.referrer) {
		let refVirtual;

		try {
			refVirtual = parseVirtual(new URL(request.referrer).pathname);
		} catch (refError) {
			refVirtual = null;
		}

		if (refVirtual) {
			const target = pathname + requestUrl.search;

			const response = request.mode === "navigate"
				? Promise.resolve(Response.redirect(requestUrl.origin + refVirtual.prefix + target, 302))
				: handleVirtualRequest(request, refVirtual.tab, refVirtual.port, target);

			recordPreviewRequest(event, refVirtual.prefix + pathname, pathname + " (referer relay)", response);
			event.respondWith(response);

			return;
		}
	}

	// A range/only-if-cached cross-origin request can't be re-fetched here — leave it to the browser.
	if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
		return;
	}

	// Fallback: everything not virtual/workspace/same-origin-relayed. A previewed app's outbound data fetch is
	// gated here (gateAndFetch resolves the client to tell a preview request from editor/CDN infra); everything
	// else passes straight through with COI stamping.
	const response = gateAndFetch(event, request, requestUrl);

	recordPreviewRequest(event, pathname, requestUrl.origin === globalThis.location.origin ? pathname : requestUrl.host + " (passthrough)", response);
	event.respondWith(response);
});
