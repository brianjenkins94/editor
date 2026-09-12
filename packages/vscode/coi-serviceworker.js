/*! coi-serviceworker — cross-origin isolation + same-origin module resolver + dev-server bridge for the editor.
 *
 * The workbench needs SharedArrayBuffer, which requires the page to be crossOriginIsolated
 * (Cross-Origin-Opener-Policy: same-origin + a Cross-Origin-Embedder-Policy). A dev server sets those
 * headers directly (vite.config.ts coi-headers), but a static host can't — so this worker stamps them
 * onto every response instead. COEP is `credentialless` (not require-corp) so the cross-origin CDN fetch
 * below, whose response carries no CORP header, keeps working.
 *
 * ONE service worker owns three roles, over one path space and with no magic module namespaces:
 *   • Module resolver — serves the workspace VFS store (vfs.ts, IndexedDB) at REAL paths under /workspace/,
 *     rewriting bare imports in served modules to the workspace's node_modules, so node-only tooling (eslint
 *     loading a flat config + plugins) and the preview pane read the workspace over ordinary fetch/import.
 *     On a store MISS under /workspace/node_modules/, it fetches the package from the CDN internally and hands
 *     it back same-origin (the fold-in that RETIRED the old `__proxy__` route — the worker's own fetch follows
 *     the CDN's unversioned 302s and isn't bound by the document's COEP). Any other miss falls through to the
 *     network, so the resolver only ADDS serving. Logic inlined here (plain JS can't import vfs.ts) — keep the
 *     constants in sync with vfs.ts.
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
import { createHub, portTransport } from "@brianjenkins94/hub";
import { relayLoggerToHub } from "./telemetry";

// The SW is a first-class hub node. Its otherwise-invisible lifecycle (CDN fallbacks, dev-server relays,
// errors) is recorded through a source-scoped logger whose records — timed SPANS included — ride the hub to
// the page's `$sys.log.>` collector. It links to the page over a DEDICATED hub port (the {type:"hub"} message
// below), separate from the ServerBridge data port. Standalone until linked — records just drop, by design.
const swHub = createHub({ "id": "sw" });
const swLog = relayLoggerToHub(swHub, "sw");

globalThis.addEventListener("install", () => globalThis.skipWaiting());
globalThis.addEventListener("activate", (event) => event.waitUntil(globalThis.clients.claim()));

// ── VFS store + resolver (mirror of vfs.ts constants; keep in sync) ───────────────────────────────────────
const VFS_DB = "vfs-store";
const VFS_STORE = "files";
const WORKSPACE_ROOT = "/workspace/";                 // store-served (workspace files + its node_modules)
const NODE_MODULES = "/workspace/node_modules/";      // where bare specifiers resolve; CDN-fallback on a miss
const CDN = "https://unpkg.com";                      // node_modules miss → fetched here, served same-origin
const RELATIVE_RE = /^[./]/u;
const SCHEME_RE = /^[a-z]+:/iu;
const JS_RE = /\.[mc]?[jt]sx?$/u;
const IMPORT_RE = /(\bimport\b[^'"]+?\bfrom\s*|\bimport\s*|\bexport\b[^'"]+?\bfrom\s*)(["'])([^"']+)\2/gu;
// Dev-server bridge route marker. Matched by indexOf (not anchored) so it's recognised under ANY deploy-base
// prefix: on GitHub Pages the app is served at /editor/, the SW is scoped to /editor/, and requests arrive as
// /editor/__virtual__/<port>/… — same reason the old __proxy__ matched by substring. /workspace/ (WORKSPACE_ROOT)
// is matched the same way below.
const VIRTUAL_MARKER = "/__virtual__/";

// A rewritable specifier: bare ("pkg", "@scope/pkg") or a node: builtin. Relative and other URL schemes
// (http:, data:, blob:) are left to native ESM.
const isBare = (spec) => !RELATIVE_RE.test(spec) && (!SCHEME_RE.test(spec) || spec.startsWith("node:"));

function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(VFS_DB, 1);

		request.onupgradeneeded = () => request.result.createObjectStore(VFS_STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function idbGet(db, key) {
	return new Promise((resolve, reject) => {
		const request = db.transaction(VFS_STORE, "readonly").objectStore(VFS_STORE).get(key);

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

// Split a node_modules-relative path ("<pkg>/<sub>" or "<pkg>") into package + subpath, honouring scopes.
function splitPackage(rel) {
	const at = rel[0] === "@" ? rel.indexOf("/", rel.indexOf("/") + 1) : rel.indexOf("/");

	return { "pkg": at === -1 ? rel : rel.slice(0, at), "sub": at === -1 ? "" : rel.slice(at + 1) };
}

// Bare specifier → a real /workspace/node_modules/ path (the store, or a network/CDN miss). package.json
// exports/main picks the entry; a subpath is used verbatim. `node:` builtins map to node_modules too (a
// zen-fs-backed / polyfill shim can be dropped there later — for now such a miss simply 404s).
async function resolveBare(db, spec) {
	const { pkg, sub } = splitPackage(spec.replace(/^node:/u, ""));
	const base = NODE_MODULES + pkg;

	if (sub !== "") {
		return base + "/" + sub;
	}

	const pjRec = await idbGet(db, base + "/package.json");

	if (pjRec === undefined) {
		return base;   // not installed → resolves to the bare dir; SW miss → network (404), same as node would error
	}

	try {
		const pj = JSON.parse(pjRec.body);
		const dot = pj.exports && (typeof pj.exports === "string" ? pj.exports : pj.exports["."] && (typeof pj.exports["."] === "string" ? pj.exports["."] : pj.exports["."].import || pj.exports["."].default));

		return base + "/" + (dot || pj.module || pj.main || "index.js").replace(/^\.\//u, "");
	} catch (error) {
		return base + "/index.js";
	}
}

// Rewrite bare specifiers in a served module to resolved /workspace/node_modules/ paths (relative/absolute
// left to native ESM, which resolves them against the served URL — all under /workspace/).
async function rewriteImports(db, source) {
	const specs = new Set();

	for (const match of source.matchAll(IMPORT_RE)) {
		if (isBare(match[3])) {
			specs.add(match[3]);
		}
	}

	if (specs.size === 0) {
		return source;
	}

	const map = {};

	for (const spec of specs) {
		map[spec] = await resolveBare(db, spec);
	}

	return source.replace(IMPORT_RE, (full, pre, quote, spec) => (map[spec] !== undefined ? pre + quote + map[spec] + quote : full));
}

function isJsPath(pathname, type) {
	return (type !== undefined && type.includes("javascript")) || JS_RE.test(pathname);
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

// Resolver: serve /workspace/ from the store (rewriting imports on a JS hit); on a miss, fall back to the CDN
// under node_modules, else pass through to the network — so this only ADDS serving and can't break a fetch.
async function serveWorkspace(request, requestUrl, pathname) {
	const db = await openDb().catch(() => undefined);
	const record = db === undefined ? undefined : await idbGet(db, pathname).catch(() => undefined);

	if (record !== undefined) {
		const body = isJsPath(pathname, record.type) ? await rewriteImports(db, record.body) : record.body;

		return new Response(body, { "headers": { "content-type": record.type, "cross-origin-resource-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" } });
	}

	if (pathname.startsWith(NODE_MODULES)) {
		return fetchCdn(pathname, requestUrl);
	}

	return stamp(await fetch(request));   // store miss outside node_modules → network, isolation-stamped
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

	event.respondWith(fetch(request).then(stamp).catch((error) => {
		console.error("[coi-serviceworker]", error);

		return Promise.reject(error);
	}));
});
