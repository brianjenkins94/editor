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
 *   • Dev-server bridge — the preview pane runs a dev server (ViteDevServer) IN THE PAGE and hands us a
 *     MessagePort (ServerBridge protocol; see packages/almostnode/server-bridge.ts). We relay
 *     `/__virtual__/<port>/…` fetches to it as request/response messages, so the preview iframe reaches the
 *     in-page server over ordinary HTTP. Merged in from almostnode's standalone __sw__.js so this ONE worker
 *     also plays that role (rather than a second SW fighting for scope `/`).
 *   • COI stamping — every other response is passed through with the isolation headers added.
 *
 * Registered by coi.ts (in prod to provide isolation; in dev, additionally, for the resolver). Pattern
 * adapted from github.com/gzuidhof/coi-serviceworker (MIT). Bundled as an ES MODULE (sw.config.ts) so it can
 * import the hub below; registered {type:module} (coi.ts / server-bridge.ts).
 */
import { createHub, createRpcClient, portTransport } from "@brianjenkins94/hub";
import { relayLoggerToHub, tapConsoleAndErrors } from "./telemetry";

// The SW is a first-class hub node. Its otherwise-invisible lifecycle (CDN fallbacks, dev-server relays,
// errors) is recorded through a source-scoped logger whose records — timed SPANS included — ride the hub to
// the page's `$sys.log.>` collector. It links to the page over a DEDICATED hub port (the {type:"hub"} message
// below), separate from the ServerBridge data port. Standalone until linked — records just drop, by design.
const swHub = createHub({ "id": "sw" });
const swLog = relayLoggerToHub(swHub, "sw");

tapConsoleAndErrors(swHub, "sw"); // raw uncaught error/rejection → the plane, beside the structured logs

// The capability NET gate. A previewed app's outbound fetch/XHR full-round-trips to the ext-host decision
// endpoint, but the SW reaches it through a TRUSTED editor client (the SW node doesn't do hub RPC): each
// trusted window client gets its own MessageChannel port; the app realm (main.tsx) relays the call to
// "capability.decide" over the hub and replies on the port. The SW holds NO policy — it only asks, then
// allows (fetch) or blocks (403). The PREVIEW client is never asked (it's the untrusted app). Fail-OPEN on a
// transport error / no editor realm, so a hiccup never bricks the preview (the endpoint fails closed itself).
// The SW is a first-class hub node (swHub, linked to the page's root hub), so it asks the ext-host decision
// endpoint DIRECTLY over the hub — swHub → root → workbench → podHub reaches worker-pod's "capability.decide"
// serve, which owns the popup / grant store / redline. The SW holds NO policy; it only asks, then allows
// (fetch) or blocks (403). A long timeout so a deliberating user isn't cut off; fail-OPEN past it / on any
// transport error, so a hub hiccup never bricks the preview (the endpoint itself fails closed on redline / an
// abstaining decider).
const capabilityRpc = createRpcClient(swHub);

// Attribute a previewed app's gated net calls to the RUN that owns its port — so multiple concurrent previews (a
// multi-server app, a multiplayer game over WS/WebRTC) each record independently, instead of a single global run.
// The shell mints {id, port} at launch (production.launch) and the run ends at production.exit.<id>; we key by
// PORT because a fetch's preview client resolves to its virtual port. Empty → the net decision stays call-grain.
const previewRunByPort = new Map();

swHub.subscribe("production.launch", (data) => {
	const id = data && data.id;
	const port = data && data.port;

	if (typeof id !== "string" || typeof port !== "number") {
		return; // no port ⇒ not a preview run (e.g. a node fallback) — nothing to attribute by port
	}

	previewRunByPort.set(port, id);

	const off = swHub.subscribe("production.exit." + id, () => {
		off();

		if (previewRunByPort.get(port) === id) {
			previewRunByPort.delete(port);
		}
	});
});

async function decideNet(url, runId) {
	try {
		return (await capabilityRpc.request("capability.decide", { "kind": "net", "args": [url], "runId": runId ?? undefined }, { "timeoutMs": 300000 })) !== false;
	} catch (rpcError) {
		swLog.error("capability.decide failed — allowing (fail-open)", { "error": String(rpcError) });

		return true;
	}
}

// Capability decision route (fs/exec, from almostnode). A worker's SYNCHRONOUS XHR blocks on this request while
// we run the async decision (same "capability.decide" endpoint the net gate uses) and reply — the sync-XHR ⇄ SW
// trick that lets a synchronous shim (writeFileSync) await an async popup with no SharedArrayBuffer. Body is the
// raw CapabilityCall; reply is `{ allow }`. Fail-OPEN on error so a hiccup never bricks a run.
async function handleCapabilityDecide(request) {
	try {
		const call = await request.json();
		const allow = (await capabilityRpc.request("capability.decide", call, { "timeoutMs": 300000 })) !== false;

		return new Response(JSON.stringify({ "allow": allow }), { "headers": { "content-type": "application/json" } });
	} catch (decideError) {
		swLog.error("capability decide route failed — allowing (fail-open)", { "error": String(decideError) });

		return new Response(JSON.stringify({ "allow": true }), { "headers": { "content-type": "application/json" } });
	}
}

// Gate a previewed app's DATA fetches (destination "" = fetch/XHR, not a subresource/module load) to http(s),
// then fetch or block. Non-preview clients and non-data requests pass straight through — same as before.
async function gateAndFetch(event, request, requestUrl) {
	try {
		if (request.destination === "" && (requestUrl.protocol === "https:" || requestUrl.protocol === "http:") && event.clientId) {
			const client = await globalThis.clients.get(event.clientId);
			let previewPort;

			try {
				const parsed = client ? parseVirtual(new URL(client.url).pathname) : null;

				previewPort = parsed ? parsed.port : undefined;
			} catch (clientError) {
				previewPort = undefined;
			}

			// A preview client's fetch → gate it, attributed to the run that owns its port (undefined runId if the
			// mapping hasn't arrived yet → recorded call-grain, still gated).
			if (previewPort !== undefined && !(await decideNet(request.url, previewRunByPort.get(previewPort)))) {
				return new Response("Blocked by capability policy: net " + requestUrl.host, { "status": 403, "statusText": "Capability denied" });
			}
		}
	} catch (gateError) {
		swLog.error("capability net gate error — allowing", { "error": String(gateError) });
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
// Dev-server bridge route marker. Matched by indexOf (not anchored) so it's recognised under ANY deploy-base
// prefix: on GitHub Pages the app is served at /editor/, the SW is scoped to /editor/, and requests arrive as
// /editor/__virtual__/<port>/… — same reason the old __proxy__ matched by substring. /workspace/ (WORKSPACE_ROOT)
// is matched the same way below.
const VIRTUAL_MARKER = "/__virtual__/";

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
async function fetchCdn(pathname, requestUrl) {
	const { pkg, sub } = splitPackage(pathname.slice(NODE_MODULES.length));
	const version = requestUrl.searchParams.get("v");
	const spec = pkg + (version === null ? "" : "@" + version) + (sub === "" ? "" : "/" + sub);
	const upstream = CDN + "/" + spec + (requestUrl.searchParams.has("meta") ? "?meta" : "");
	// A timed span: the collector shows `→ cdn` / `← cdn (Xms)`, so a slow/failed CDN fallback is visible.
	const span = swLog.span("cdn", { "spec": spec });

	try {
		const response = await fetch(upstream);
		const headers = new Headers(response.headers);

		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Cross-Origin-Resource-Policy", "cross-origin");

		span.end({ "status": response.status });

		return new Response(response.body, { "status": response.status, "statusText": response.statusText, "headers": headers });
	} catch (error) {
		console.error("[coi-serviceworker] cdn", upstream, error);
		span.error("cdn failed", { "upstream": upstream, "error": String(error) });
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

// ── Dev-server bridge (ServerBridge protocol; mirror of almostnode's __sw__.js) ───────────────────────────
// The in-page ServerBridge transfers us a MessagePort via a {type:"init"} message; we relay /__virtual__/
// fetches to the in-page dev server over it as {type:"request"} and await {type:"response"} / stream frames.
let mainPort = null;
const pendingRequests = new Map();
let bridgeRequestId = 0;

function base64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return bytes;
}

// Responses (and stream frames) coming back from the in-page dev server, keyed by request id.
function handleMainMessage(event) {
	const { type, id, data, error } = event.data;
	const pending = pendingRequests.get(id);

	if (type === "response") {
		if (pending === undefined) {
			return;
		}

		pendingRequests.delete(id);

		if (error !== undefined) {
			pending.reject(new Error(error));
		} else {
			pending.resolve(data);
		}
	} else if (type === "stream-start") {
		if (pending && pending.streamController) {
			pending.resolveHeaders(data);
		}
	} else if (type === "stream-chunk") {
		if (pending && pending.streamController && data.chunkBase64) {
			try {
				pending.streamController.enqueue(base64ToBytes(data.chunkBase64));
			} catch (streamError) {
				console.error("[coi-serviceworker] stream chunk", streamError);
			}
		}
	} else if (type === "stream-end") {
		if (pending && pending.streamController) {
			try {
				pending.streamController.close();
			} catch (streamError) {
				// already closed — ignore
			}

			pendingRequests.delete(id);
		}
	}
}

// The in-page ServerBridge sends {type:"init"} (with a transferred MessagePort), plus server-registered/
// -unregistered and keepalive pings (ignored — receipt alone keeps the worker warm).
globalThis.addEventListener("message", (event) => {
	const data = event.data;

	if (data && data.type === "init" && event.ports && event.ports[0]) {
		mainPort = event.ports[0];
		mainPort.onmessage = handleMainMessage;
		// Re-claim so a preview page opened after activation is controlled.
		globalThis.clients.claim();
	}

	// Dedicated observability link: the page hands us a hub port (telemetry.ts linkServiceWorkerHub). Link our
	// hub over it so `$sys.log.sw` records federate to the page's collector.
	if (data && data.type === "hub" && event.ports && event.ports[0]) {
		swHub.link(portTransport(event.ports[0]));
		swLog.info("hub linked");
	}
});

// The port drops when the worker is idle-terminated or replaced; ask clients to re-init and wait briefly.
async function ensureMainPort() {
	if (mainPort) {
		return;
	}

	const clients = await globalThis.clients.matchAll({ "type": "window" });

	for (const client of clients) {
		client.postMessage({ "type": "sw-needs-init" });
	}

	await new Promise((resolve) => {
		const check = setInterval(() => {
			if (mainPort) {
				clearInterval(check);
				resolve();
			}
		}, 50);

		setTimeout(() => {
			clearInterval(check);
			resolve();
		}, 5000);
	});

	if (!mainPort) {
		throw new Error("dev-server bridge not initialized");
	}
}

async function sendRequest(port, method, url, headers, body) {
	await ensureMainPort();

	bridgeRequestId += 1;
	const id = bridgeRequestId;

	return new Promise((resolve, reject) => {
		pendingRequests.set(id, { "resolve": resolve, "reject": reject });

		setTimeout(() => {
			if (pendingRequests.has(id)) {
				pendingRequests.delete(id);
				reject(new Error("dev-server bridge request timeout"));
			}
		}, 30000);

		mainPort.postMessage({ "type": "request", "id": id, "data": { "port": port, "method": method, "url": url, "headers": headers, "body": body } });
	});
}

async function sendStreamingRequest(port, method, url, headers, body) {
	await ensureMainPort();

	bridgeRequestId += 1;
	const id = bridgeRequestId;
	let resolveHeaders;
	const headersPromise = new Promise((resolve) => {
		resolveHeaders = resolve;
	});
	const stream = new ReadableStream({
		"start": function(controller) {
			pendingRequests.set(id, { "resolve": () => undefined, "reject": (err) => controller.error(err), "streamController": controller, "resolveHeaders": resolveHeaders });
			mainPort.postMessage({ "type": "request", "id": id, "data": { "port": port, "method": method, "url": url, "headers": headers, "body": body, "streaming": true } });
		},
		"cancel": function() { pendingRequests.delete(id); }
	});

	return { "stream": stream, "headersPromise": headersPromise };
}

// Add the isolation + iframe-embedding headers a virtual (dev-server) response needs.
function virtualHeaders(source) {
	const headers = new Headers(source || {});

	headers.set("Cross-Origin-Embedder-Policy", "credentialless");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	headers.delete("X-Frame-Options");

	return headers;
}

// Relay one request to the in-page dev server on `port` and build a Response from its reply. A POST to /api/*
// uses the streaming path (SSE / chunked API routes); everything else is a buffered request/response.
async function handleVirtualRequest(request, port, path) {
	// A timed span per relay — the collector shows each dev-server round-trip and its duration.
	const span = swLog.span("bridge", { "port": port, "method": request.method, "path": path });

	try {
		const headers = {};

		request.headers.forEach((value, key) => {
			headers[key] = value;
		});

		const body = request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : null;

		if (request.method === "POST" && path.startsWith("/api/")) {
			const { stream, headersPromise } = await sendStreamingRequest(port, request.method, path, headers, body);
			const responseData = await headersPromise;

			return new Response(stream, { "status": (responseData && responseData.statusCode) || 200, "statusText": (responseData && responseData.statusMessage) || "OK", "headers": virtualHeaders(responseData && responseData.headers) });
		}

		const response = await sendRequest(port, request.method, path, headers, body);
		const headers2 = virtualHeaders(response.headers);

		if (response.bodyBase64 && response.bodyBase64.length > 0) {
			const blob = new Blob([base64ToBytes(response.bodyBase64)], { "type": (response.headers && response.headers["Content-Type"]) || "application/octet-stream" });

			return new Response(blob, { "status": response.statusCode, "statusText": response.statusMessage, "headers": headers2 });
		}

		return new Response(null, { "status": response.statusCode, "statusText": response.statusMessage, "headers": headers2 });
	} catch (error) {
		console.error("[coi-serviceworker] virtual", error);
		span.error("bridge failed", { "error": String(error) });

		return new Response("dev-server bridge error: " + error.message, { "status": 500, "headers": { "content-type": "text/plain" } });
	} finally {
		span.end();
	}
}

// Parse a `/__virtual__/<port>/<rest>` path — found ANYWHERE (under any deploy-base prefix) — into its parts.
function parseVirtual(pathname) {
	const index = pathname.indexOf(VIRTUAL_MARKER);

	if (index === -1) {
		return null;
	}

	const after = pathname.slice(index + VIRTUAL_MARKER.length);
	const slash = after.indexOf("/");
	const portStr = slash === -1 ? after : after.slice(0, slash);
	const port = parseInt(portStr, 10);

	if (!Number.isFinite(port)) {
		return null;
	}

	return {
		"port": port,
		"rest": slash === -1 ? "" : after.slice(slash),
		// The URL prefix up to and including the port (base + /__virtual__/<port>), for navigation redirects.
		"prefix": pathname.slice(0, index + VIRTUAL_MARKER.length + portStr.length)
	};
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

	// Dev-server bridge: <base>/__virtual__/<port>/…
	const virtual = parseVirtual(pathname);

	if (virtual !== null) {
		event.respondWith(handleVirtualRequest(request, virtual.port, (virtual.rest || "/") + requestUrl.search));

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

			if (request.mode === "navigate") {
				event.respondWith(Response.redirect(requestUrl.origin + refVirtual.prefix + target, 302));
			} else {
				event.respondWith(handleVirtualRequest(request, refVirtual.port, target));
			}

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
	event.respondWith(gateAndFetch(event, request, requestUrl));
});
