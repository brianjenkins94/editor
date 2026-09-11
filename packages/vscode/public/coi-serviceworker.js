/*! coi-serviceworker — cross-origin isolation + same-origin module resolver for the editor.
 *
 * The workbench needs SharedArrayBuffer, which requires the page to be crossOriginIsolated
 * (Cross-Origin-Opener-Policy: same-origin + a Cross-Origin-Embedder-Policy). A dev server sets those
 * headers directly (vite.config.ts coi-headers), but a static host can't — so this worker stamps them
 * onto every response instead. COEP is `credentialless` (not require-corp) so the CDN node_modules
 * overlay's cross-origin unpkg fetches, which carry no CORP header, keep working.
 *
 * It also OWNS the same-origin module resolver: it serves the workspace VFS store (vfs.ts, IndexedDB) at
 * real paths and resolves bare/builtin imports in served modules, so node-only tooling (eslint loading a
 * flat config + plugins) and the preview pane can read the workspace over ordinary fetch/import. Store +
 * resolver logic is inlined here (plain JS can't import vfs.ts) — keep the constants in sync with vfs.ts.
 *
 * Registered by coi.ts (in prod to provide isolation; in dev, additionally, for the resolver). Pattern
 * adapted from github.com/gzuidhof/coi-serviceworker (MIT). Plain JS (served from public/ untouched by vite).
 */
globalThis.addEventListener("install", () => globalThis.skipWaiting());
globalThis.addEventListener("activate", (event) => event.waitUntil(globalThis.clients.claim()));

// ── VFS store + resolver (mirror of vfs.ts constants; keep in sync) ───────────────────────────────────────
const VFS_DB = "vfs-store";
const VFS_STORE = "files";
const WORKSPACE_ROOT = "/workspace/";       // store-served (workspace files, incl. its node_modules)
const NODE_MODULES = "/workspace/node_modules/";
const CDN_SEGMENT = "/__cdn__/";            // resolver's CDN-fallback namespace
const NODE_SEGMENT = "/__node__/";          // resolver's node-builtin-shim namespace
const CDN = "https://esm.sh";
const BUILTINS = new Set(["fs", "path", "os", "util", "url", "crypto", "zlib", "stream", "events", "assert", "process", "buffer", "string_decoder", "tty", "module", "perf_hooks", "constants", "querystring", "async_hooks"]);

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

// Bare specifier → resolved same-origin path. Node builtin → shim namespace; installed pkg → the workspace's
// node_modules (package.json exports/main); otherwise → CDN-fallback namespace.
async function resolveBare(db, spec) {
	const nodeName = spec.replace(/^node:/u, "");

	if (BUILTINS.has(nodeName) || BUILTINS.has(nodeName.split("/")[0])) {
		return NODE_SEGMENT + nodeName;   // node builtin → shim namespace
	}

	const at = spec[0] === "@" ? spec.indexOf("/", spec.indexOf("/") + 1) : spec.indexOf("/");
	const pkg = at === -1 ? spec : spec.slice(0, at);
	const sub = at === -1 ? "" : spec.slice(at + 1);
	const base = NODE_MODULES + pkg;
	const pjRec = await idbGet(db, base + "/package.json");

	if (pjRec === undefined) {
		return CDN_SEGMENT + spec;   // not installed locally → CDN fallback
	}
	if (sub !== "") {
		return base + "/" + sub;
	}
	try {
		const pj = JSON.parse(pjRec.body);
		const dot = pj.exports && (typeof pj.exports === "string" ? pj.exports : pj.exports["."] && (typeof pj.exports["."] === "string" ? pj.exports["."] : pj.exports["."].import || pj.exports["."].default));

		return base + "/" + (dot || pj.module || pj.main || "index.js").replace(/^\.\//u, "");
	} catch (error) {
		return base + "/index.js";
	}
}

const IMPORT_RE = /(\bimport\b[^'"]+?\bfrom\s*|\bimport\s*|\bexport\b[^'"]+?\bfrom\s*)(["'])([^"']+)\2/gu;
const RELATIVE_RE = /^[./]/u;
const SCHEME_RE = /^[a-z]+:/iu;
const JS_RE = /\.[mc]?[jt]sx?$/u;

const isBare = (spec) => !RELATIVE_RE.test(spec) && !SCHEME_RE.test(spec);

// Rewrite bare specifiers in a STORE module to resolved same-origin paths (relative/absolute left alone).
async function rewriteStore(db, source) {
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

// Rewrite imports in a CDN module so the whole graph stays same-origin under /__cdn__/.
function rewriteCdn(source) {
	return source.replace(IMPORT_RE, (full, pre, quote, spec) => {
		let out = spec;

		if (spec.startsWith(CDN + "/")) {
			out = CDN_SEGMENT + spec.slice(CDN.length + 1);
		} else if (spec.startsWith("https://")) {
			out = CDN_SEGMENT + spec.slice("https://".length);
		} else if (spec.startsWith("/")) {
			out = "/__cdn__" + spec;
		} else if (isBare(spec)) {
			out = CDN_SEGMENT + spec;
		}

		return pre + quote + out + quote;
	});
}

function isJsPath(pathname, type) {
	return (type !== undefined && type.includes("javascript")) || JS_RE.test(pathname);
}

globalThis.addEventListener("fetch", (event) => {
	const request = event.request;
	const requestUrl = new URL(request.url);
	const pathname = requestUrl.pathname;

	// ── Resolver: CDN-fallback namespace — fetch esm.sh internally, rewrite its graph to stay same-origin ──
	if (pathname.startsWith(CDN_SEGMENT) || pathname.indexOf(CDN_SEGMENT) !== -1) {
		const rest = pathname.slice(pathname.indexOf(CDN_SEGMENT) + CDN_SEGMENT.length);

		event.respondWith((async () => {
			const response = await fetch(CDN + "/" + rest + requestUrl.search, { "redirect": "follow" });
			const type = response.headers.get("content-type") || "text/javascript";
			const body = type.includes("javascript") ? rewriteCdn(await response.text()) : await response.text();

			return new Response(body, { "status": response.status, "headers": { "content-type": type, "cross-origin-resource-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" } });
		})().catch((error) => {
			console.error("[coi-serviceworker] cdn", rest, error);

			return new Response("/* cdn error */", { "status": 502, "headers": { "content-type": "text/javascript" } });
		}));

		return;
	}

	// ── Resolver: node-builtin shims ──
	if (pathname.indexOf(NODE_SEGMENT) !== -1) {
		event.respondWith((async () => {
			const record = await openDb().then((db) => idbGet(db, pathname)).catch(() => undefined);

			if (record === undefined) {
				return new Response("/* no shim: " + pathname + " */", { "status": 404, "headers": { "content-type": "text/javascript" } });
			}

			return new Response(record.body, { "headers": { "content-type": record.type, "cross-origin-resource-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" } });
		})());

		return;
	}

	// ── Resolver: workspace store — serve (with import rewriting) on a HIT; on a miss fall through to the
	//    network branch below (so this only ADDS store-serving and can't break any existing /workspace fetch). ──
	if (pathname.startsWith(WORKSPACE_ROOT)) {
		event.respondWith((async () => {
			const db = await openDb().catch(() => undefined);
			const record = db === undefined ? undefined : await idbGet(db, pathname).catch(() => undefined);

			if (record !== undefined) {
				const body = isJsPath(pathname, record.type) ? await rewriteStore(db, record.body) : record.body;

				return new Response(body, { "headers": { "content-type": record.type, "cross-origin-resource-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" } });
			}

			return stamp(await fetch(request)); // store miss → network, isolation-stamped (as the general branch)
		})());

		return;
	}

	// __proxy__ — same-origin CDN proxy (mirrors proxy.ts; the SW can't import it, so the segment +
	// reconstruction are inlined — keep in sync). A same-origin request `<…>/__proxy__/<host>/<path>` is
	// the node_modules overlay reaching a CDN. We fetch the real https URL here: a SW fetch isn't bound by
	// the document's COEP and follows redirects internally (so unpkg's unversioned 302, which lacks CORS,
	// still resolves), then we hand it back as a same-origin, isolation-friendly resource.
	const proxyMarker = "/__proxy__/";
	const proxyIndex = pathname.indexOf(proxyMarker);

	if (proxyIndex !== -1) {
		const realUrl = "https://" + pathname.slice(proxyIndex + proxyMarker.length) + requestUrl.search;

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

	event.respondWith(fetch(request).then(stamp).catch((error) => {
		console.error("[coi-serviceworker]", error);

		return Promise.reject(error);
	}));
});

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
