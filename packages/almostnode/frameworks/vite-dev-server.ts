/* eslint-disable ts/no-unused-private-class-members, regexp/no-contradiction-with-assertion -- vendored fork of macaly/almostnode — upstream/runtime idioms kept close to source, not restyled to this repo rules */
/* eslint-disable webawesome/no-html-in-strings -- a Vite dev server that assembles and injects SERVED HTML documents as text (import maps, HMR + React-Refresh script payloads); these strings are the payload, not app chrome */
/**
 * ViteDevServer - Vite-compatible dev server for browser environment
 * Serves files from VirtualFS with JSX/TypeScript transformation
 */

import type { DevServerOptions, HMRUpdate, ResponseData } from "../dev-server";
import type { VirtualFS } from "../virtual-fs";
import ts from "typescript";
import { REACT_REFRESH_CDN, REACT_VERSION } from "../config/cdn";
import { DevServer } from "../dev-server";
import { Buffer } from "../shims/stream";
import { simpleHash } from "../utils/hash";
import { addReactRefresh as _addReactRefresh, shiftInlineSourceMap } from "./code-transforms";
import type { InstrumentLevel } from "./instrument";
import { instrument } from "./instrument";
import type { Manifest } from "./packages";
import { isRegistrySpec, PACKAGE_PREFIX, PackageResolver } from "./packages";

// Check if we're in a real runtime that should transpile (not jsdom or a Node test).
// A real browser has window + navigator.serviceWorker (jsdom has window but not that); a Web Worker (where the
// editor runs this dev server, off the main thread) has no window at all but IS a real runtime with `ts` loaded,
// so detect WorkerGlobalScope too — otherwise transformCode() would serve raw TSX and the browser chokes on JSX.
const isBrowser = (typeof window !== "undefined"
	&& typeof window.navigator !== "undefined"
	&& "serviceWorker" in window.navigator)
	|| typeof WorkerGlobalScope !== "undefined";

// Transpilation uses the browser TypeScript compiler (`ts.transpileModule`) — see transformCode(). The
// editor already loads `typescript` (tsval, the preflight engine, the tsserver worker), so this reuses that
// one instance instead of fetching a multi-MB esbuild-wasm binary from a CDN at runtime.

export interface ViteDevServerOptions extends DevServerOptions {
  /**
   * Enable JSX transformation (default: true)
   */
	"jsx"?: boolean;

  /**
   * JSX factory function (default: 'React.createElement')
   */
	"jsxFactory"?: string;

  /**
   * JSX fragment function (default: 'React.Fragment')
   */
	"jsxFragment"?: string;

  /**
   * Auto-inject React import for JSX files (default: true)
   */
	"jsxAutoImport"?: boolean;
}

/** The shape reported for a first-attempt transform failure (see ViteDevServer.setTransformErrorReporter). */
export interface TransformErrorInfo {
	/** The requested module URL/path whose transform threw. */
	"url": string;
	/** The error's constructor name (or `typeof` for a non-Error throw) — e.g. "Error", "TypeError". */
	"name": string;
	"message": string;
	"stack"?: string;
}

/**
 * React Refresh preamble — MUST run before React is loaded, and before any app module runs.
 *
 * The runtime is a STATIC import. The browser runs deferred module scripts in document order and won't start the
 * app's until this one's whole import graph has loaded, so the app can't run before `$RefreshReg$` exists. (It does
 * NOT wait for a top-level `await`: an `await import(runtime)` here let the app run first whenever the CDN was slow —
 * a blank preview on a cold cache.)
 *
 * The classic script before it defines no-op stubs, run during parsing ahead of every module: if the runtime can't
 * load at all, the transformed modules' `$RefreshReg$` calls still succeed and the app renders, just without Fast
 * Refresh. The module replaces them once the runtime is in.
 */
const REACT_REFRESH_PREAMBLE = `
<script>
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
// The HMR client tells which modules THIS window loaded from resource timing: keep every entry (the default buffer
// holds 250).
try { performance.setResourceTimingBufferSize(100000); } catch (e) {}
</script>
<script type="module">
import * as RefreshRuntimeModule from '${REACT_REFRESH_CDN}';

const RefreshRuntime = RefreshRuntimeModule.default || RefreshRuntimeModule;

// Hook into React BEFORE it's loaded
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshRuntime$ = RefreshRuntime;

// Track registrations for debugging
window.$RefreshRegCount$ = 0;

// Register function called by transformed modules
window.$RefreshReg$ = (type, id) => {
  window.$RefreshRegCount$++;
  RefreshRuntime.register(type, id);
};

// Signature function (simplified - always returns identity)
window.$RefreshSig$ = () => (type) => type;

console.log('[HMR] React Refresh initialized');
</script>
`;

/**
 * HMR client script injected into index.html
 * Implements the import.meta.hot API and handles HMR updates
 */
const HMR_CLIENT_SCRIPT = `
<script type="module">
(function() {
  // Track hot modules and their callbacks
  const hotModules = new Map();
  const pendingUpdates = new Map();

  // Implement import.meta.hot API (Vite-compatible)
  window.__vite_hot_context__ = function createHotContext(ownerPath) {
    // Return existing context if already created
    if (hotModules.has(ownerPath)) {
      return hotModules.get(ownerPath);
    }

    const hot = {
      // Persisted data between updates
      data: {},

      // Accept self-updates
      accept(callback) {
        hot._acceptCallback = callback;
      },

      // Cleanup before update
      dispose(callback) {
        hot._disposeCallback = callback;
      },

      // Force full reload
      invalidate() {
        location.reload();
      },

      // Prune callback (called when module is no longer imported)
      prune(callback) {
        hot._pruneCallback = callback;
      },

      // Event handlers (not implemented)
      on(event, cb) {},
      off(event, cb) {},
      send(event, data) {},

      // Internal callbacks
      _acceptCallback: null,
      _disposeCallback: null,
      _pruneCallback: null,
    };

    hotModules.set(ownerPath, hot);
    return hot;
  };

  // Listen for HMR updates via postMessage (works with sandboxed iframes)
  window.addEventListener('message', async (event) => {
    // Filter for HMR messages only
    if (!event.data || event.data.channel !== 'vite-hmr') return;
    const { type, path, timestamp } = event.data;

    if (type === 'update') {
      console.log('[HMR] Update:', path);

      if (path.endsWith('.css')) {
        // CSS hot reload - update stylesheet href
        const links = document.querySelectorAll('link[rel="stylesheet"]');
        links.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.includes(path.replace(/^\\//, ''))) {
            link.href = href.split('?')[0] + '?t=' + timestamp;
          }
        });

        // Also update any injected style tags
        const styles = document.querySelectorAll('style[data-vite-dev-id]');
        styles.forEach(style => {
          const id = style.getAttribute('data-vite-dev-id');
          if (id && id.includes(path.replace(/^\\//, ''))) {
            // Re-import the CSS module to get updated styles
            import(path + '?t=' + timestamp).catch(() => {});
          }
        });
      } else if (path.match(/\\.(jsx?|tsx?)$/)) {
        // JS/JSX hot reload with React Refresh
        await handleJSUpdate(path, timestamp);
      }
    } else if (type === 'full-reload') {
      console.log('[HMR] Full reload');
      location.reload();
    }
  });

  // Did THIS window load the module? (A module fetch lands in its realm's resource timing.) An update to a module only
  // a sibling frame or a worker loaded isn't this window's to apply.
  function loadedHere(path) {
    return performance.getEntriesByType('resource').some((entry) => {
      try {
        return new URL(entry.name).pathname.endsWith(path);
      } catch (error) {
        return false;
      }
    });
  }

  // Handle JS/JSX module updates
  async function handleJSUpdate(path, timestamp) {
    // Normalize path to match module keys
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const hot = hotModules.get(normalizedPath);

    if (!hot && !loadedHere(normalizedPath)) {
      return;
    }

    // Only a module with a hot context (a React module, via React Refresh) can be swapped in place. Any other module's
    // importers still hold its old exports, so re-importing it would only run it twice — reload this frame instead.
    if (!hot) {
      console.log('[HMR] ' + normalizedPath + ' has no hot boundary: reloading');
      location.reload();
      return;
    }

    try {
      // Call dispose callback if registered
      if (hot && hot._disposeCallback) {
        hot._disposeCallback(hot.data);
      }

      // Enqueue React Refresh (batches multiple updates)
      if (window.$RefreshRuntime$) {
        pendingUpdates.set(normalizedPath, timestamp);

        // Schedule refresh after a short delay to batch updates
        if (pendingUpdates.size === 1) {
          setTimeout(async () => {
            try {
              // Re-import all pending modules
              for (const [modulePath, ts] of pendingUpdates) {
                const moduleUrl = '.' + modulePath + '?t=' + ts;
                await import(moduleUrl);
              }

              // Perform React Refresh
              window.$RefreshRuntime$.performReactRefresh();
              console.log('[HMR] Updated', pendingUpdates.size, 'module(s)');

              pendingUpdates.clear();
            } catch (error) {
              console.error('[HMR] Failed to apply update:', error);
              pendingUpdates.clear();
              location.reload();
            }
          }, 30);
        }
      } else {
        // No React Refresh available, fall back to page reload
        console.log('[HMR] React Refresh not available, reloading page');
        location.reload();
      }
    } catch (error) {
      console.error('[HMR] Update failed:', error);
      location.reload();
    }
  }

  console.log('[HMR] Client ready with React Refresh support');
})();
</script>
`;

/**
 * The esm.sh URL for a registry dependency's `subpath` ("" or "/sub"). One definition for the import map and for
 * rewritten imports, so a module loads once whichever way it's reached: react/react-dom get the `?dev` build the
 * React-Refresh preamble hooks; other deps get `?external=react,react-dom`, so a component library shares the app's
 * single React copy rather than pulling its own.
 */
function registryUrl(name: string, version: string, subpath: string): string {
	const query = name === "react" || name === "react-dom" ? "dev" : "external=react,react-dom";

	return `https://esm.sh/${name}@${version}` + (subpath === "" ? `?${query}` : `&${query}${subpath}`);
}

/** The git blob oid of `text` (sha1 of `blob <length>\0<bytes>`): a module version's name, as git and runtime evidence
 *  name a file's content. */
async function blobOid(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const object = new Uint8Array(header.length + bytes.length);

	object.set(header);
	object.set(bytes, header.length);

	return [...new Uint8Array(await crypto.subtle.digest("SHA-1", object))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ViteDevServer extends DevServer {
	private watcherCleanup: (() => void) | null = null;
	private readonly options: ViteDevServerOptions;
	private hmrTargetWindow: Window | null = null;
	private transformErrorReporter: ((info: TransformErrorInfo) => void) | null = null;
	private readonly transformCache = new Map<string, { "code": string; "hash": string; "level": InstrumentLevel | "off"; "stops": string }>();
	/** The recorded stops (packages/editor/RUNNING.md: a breakpoint in a page), by file: the lines (1-based) whose code
	 *  records what's in scope each time it runs. A file with any is instrumented whatever the level. */
	private stops = new Map<string, number[]>();
	/** How much of the workspace's modules to instrument for runtime evidence (instrument.ts): off until told. */
	private instrumentLevel: InstrumentLevel | "off" = "off";
	/** Each version of a workspace module instrumented, by its source's git blob oid: what it was — so the evidence of
	 *  a version a hot update replaced can still be read against its own text (RUNTIME-EVIDENCE.md, the third slice). */
	private readonly versions = new Map<string, { "file": string; "source": string }>();
	/** Bare imports → esm.sh (registry deps) or /@pkg/ (URL/tarball deps, fetched and served here). See packages.ts. */
	private readonly packages: PackageResolver;

	constructor(vfs: VirtualFS, options: ViteDevServerOptions) {
		super(vfs, options);
		this.packages = new PackageResolver({ "manifest": () => this.readManifest(), "registryUrl": registryUrl });
		this.options = {
			"jsx": true,
			"jsxFactory": "React.createElement",
			"jsxFragment": "React.Fragment",
			"jsxAutoImport": true,
			...options
		};
	}

  /**
   * Set the target window for HMR updates (typically iframe.contentWindow)
   * This enables HMR to work with sandboxed iframes via postMessage
   */
	setHMRTarget(targetWindow: Window): void {
		this.hmrTargetWindow = targetWindow;
	}

  /**
   * Report a transform failure to an external sink — e.g. the host worker's hub logger — so a cold-start transform
   * failure surfaces in the observability plane rather than only as a worker `console.warn` (which a remote agent
   * can't read). See transformAndServe.
   */
	setTransformErrorReporter(reporter: (info: TransformErrorInfo) => void): void {
		this.transformErrorReporter = reporter;
	}

  /**
   * Instrument the workspace's modules for runtime evidence — everything, statements only, or not at all (instrument.ts).
   * Modules served after this are; a page reloaded gets them.
   */
	setInstrumentation(level: InstrumentLevel | "off"): void {
		this.instrumentLevel = level;
	}

  /**
   * The recorded stops, by absolute file path: the lines (1-based) whose code records what's in scope each time it
   * runs. Answers the files whose stops changed — re-transformed when next served; the host hot-updates them.
   */
	setStops(stops: Record<string, number[]>): string[] {
		const next = new Map(Object.entries(stops).filter(([, lines]) => lines.length > 0).map(([file, lines]) => [file, [...new Set(lines)].toSorted((a, b) => a - b)]));
		const changed = [...new Set([...this.stops.keys(), ...next.keys()])].filter((file) => (this.stops.get(file) ?? []).join(",") !== (next.get(file) ?? []).join(","));

		this.stops = next;

		return changed;
	}

	/** `file`'s stops, as the transform cache keys them. */
	private stopsKey(file: string): string {
		return (this.stops.get(file) ?? []).join(",");
	}

  /** A version of a workspace module this server instrumented, by its source's git blob oid. */
	versionSource(oid: string): { "file": string; "source": string } | undefined {
		return this.versions.get(oid);
	}

  /**
   * Externally trigger an HMR update for `path` (root-relative URL path, e.g. "/src/App.tsx"). For hosts whose
   * VFS doesn't emit watch events — a Web Worker on a shared zen-fs — where startWatching() can't observe saves.
   */
	notifyChange(path: string): void {
		this.handleFileChange(path);
	}

  /**
   * Handle an incoming HTTP request
   */
	async handleRequest(
		method: string,
		url: string,
		headers: Record<string, string>,
		body?: Buffer
	): Promise<ResponseData> {
    // Parse URL
		const urlObj = new URL(url, "http://localhost");
		let { pathname } = urlObj;

		// A file of a URL/tarball dependency (see packages.ts).
		if (pathname.startsWith(PACKAGE_PREFIX)) {
			return this.servePackageFile(pathname);
		}

    // Handle root path - serve index.html
		if (pathname === "/") {
			pathname = "/index.html";
		}

    // Resolve the full path
		let filePath = this.resolvePath(pathname);

    // Check if file exists
		if (!this.exists(filePath)) {
      // Try with .html extension
			if (this.exists(filePath + ".html")) {
				return this.serveFile(filePath + ".html");
			}

      // Extensionless module import ("./App" → "./App.tsx", or a bare dir → its index.*): idiomatic TS/React
      // imports omit the source extension, so try the common ones (and /index.*) before giving up. Serving and
      // transform decisions below key off `pathname`, so extend it in lockstep with `filePath`.
			const suffix = this.resolveExtensionSuffix(filePath);

			if (suffix !== undefined) {
				filePath += suffix;
				pathname += suffix;
			} else if (this.isDirectory(filePath) && this.exists(filePath + "/index.html")) {
        // Try index.html in directory
				return this.serveFile(filePath + "/index.html");
			} else {
				return this.notFound(pathname);
			}
		}

    // If it's a directory, redirect to index.html
		if (this.isDirectory(filePath)) {
			if (this.exists(filePath + "/index.html")) {
				return this.serveFile(filePath + "/index.html");
			}

			return this.notFound(pathname);
		}

    // Check if file needs transformation (JSX/TS)
		if (this.needsTransform(pathname)) {
			return this.transformAndServe(filePath, pathname);
		}

    // Check if CSS is being imported as a module (needs to be converted to JS)
    // In browser context with ES modules, CSS imports need to be served as JS
		if (pathname.endsWith(".css")) {
      // Check various header formats for sec-fetch-dest
			const secFetchDest =
				headers["sec-fetch-dest"]
				|| headers["Sec-Fetch-Dest"]
				|| headers["SEC-FETCH-DEST"]
				|| "";

      // In browser, serve CSS as module when:
      // 1. Requested as a script (sec-fetch-dest: script)
      // 2. Empty dest (sec-fetch-dest: empty) - fetch() calls
      // 3. No sec-fetch-dest but in browser context - assume module import
			const isModuleImport =
				secFetchDest === "script"
				|| secFetchDest === "empty"
				|| (isBrowser && secFetchDest === "");

			if (isModuleImport) {
				return this.serveCssAsModule(filePath);
			}

      // Otherwise serve as regular CSS (e.g., <link> tags with sec-fetch-dest: style)
			return this.serveFile(filePath);
		}

    // Check if it's HTML that needs HMR client injection
		if (pathname.endsWith(".html")) {
			return this.serveHtmlWithHMR(filePath);
		}

    // Plain JS modules get their bare imports rewritten too (see packages.ts); anything else is served as is.
		if (/\.m?js$/u.test(pathname)) {
			return this.serveRewrittenJs(filePath, pathname);
		}

		return this.serveFile(filePath);
	}

	/** The app's package.json (at the server root), or undefined. */
	private readManifest(): Manifest | undefined {
		try {
			return JSON.parse(this.vfs.readFileSync(this.root === "/" ? "/package.json" : `${this.root}/package.json`, "utf8") as string) as Manifest;
		} catch {
			return undefined;
		}
	}

	private javascript(code: string, headers: Record<string, string> = {}): ResponseData {
		const buffer = Buffer.from(code);

		return {
			"statusCode": 200,
			"statusMessage": "OK",
			"headers": { "Content-Type": "application/javascript; charset=utf-8", "Content-Length": String(buffer.length), "Cache-Control": "no-cache", ...headers },
			"body": buffer
		};
	}

	private async serveRewrittenJs(filePath: string, urlPath: string): Promise<ResponseData> {
		// Instrumented (or with a recorded stop), a workspace script goes through the compile like TypeScript does (P2).
		if ((this.instrumentLevel !== "off" || this.stops.has(filePath)) && !filePath.includes("/node_modules/")) {
			return this.transformAndServe(filePath, urlPath);
		}

		try {
			return this.javascript(await this.packages.rewriteImports(this.vfs.readFileSync(filePath, "utf8") as string, urlPath, ts));
		} catch (error) {
			return this.serverError(error);
		}
	}

	/** A file of a URL/tarball dependency; JS gets its own bare imports rewritten. */
	private async servePackageFile(pathname: string): Promise<ResponseData> {
		let body: Uint8Array | undefined;

		try {
			body = await this.packages.file(pathname);
		} catch (error) {
			return this.serverError(error);
		}

		if (body === undefined) {
			return this.notFound(pathname);
		}

		if (/\.m?js$/u.test(pathname)) {
			return this.javascript(await this.packages.rewriteImports(new TextDecoder().decode(body), pathname, ts));
		}

		const buffer = Buffer.from(body);
		const type = pathname.endsWith(".json") ? "application/json" : pathname.endsWith(".css") ? "text/css" : "application/octet-stream";

		return { "statusCode": 200, "statusMessage": "OK", "headers": { "Content-Type": type, "Content-Length": String(buffer.length), "Cache-Control": "no-cache" }, "body": buffer };
	}

  /** Resolve an extensionless import to a real VFS file: try source extensions, then /index.<ext>. */
	private resolveExtensionSuffix(filePath: string): string | undefined {
		const exts = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];

		for (const ext of exts) {
			if (this.exists(filePath + ext)) {
				return ext;
			}
		}

		for (const ext of exts) {
			if (this.exists(filePath + "/index" + ext)) {
				return "/index" + ext;
			}
		}

		return undefined;
	}

  /**
   * Start file watching for HMR
   */
	startWatching(): void {
    // Watch /src directory for changes
		const srcPath = this.root === "/" ? "/src" : `${this.root}/src`;

		try {
			const watcher = this.vfs.watch(srcPath, { "recursive": true }, (eventType, filename) => {
				if (eventType === "change" && filename) {
					const fullPath = filename.startsWith("/") ? filename : `${srcPath}/${filename}`;

					this.handleFileChange(fullPath);
				}
			});

			this.watcherCleanup = () => {
				watcher.close();
			};
		} catch (error) {
			console.warn("[ViteDevServer] Could not watch /src directory:", error);
		}

    // Also watch for CSS files in root
		try {
			const rootWatcher = this.vfs.watch(this.root, { "recursive": false }, (eventType, filename) => {
				if (eventType === "change" && filename && filename.endsWith(".css")) {
					this.handleFileChange(`${this.root}/${filename}`);
				}
			});

			const originalCleanup = this.watcherCleanup;

			this.watcherCleanup = () => {
				originalCleanup?.();
				rootWatcher.close();
			};
		} catch {
      // Ignore if root watching fails
		}
	}

  /**
   * Handle file change event
   */
	private handleFileChange(path: string): void {
    // Determine update type:
    // - CSS and JS/JSX/TSX files: 'update' (handled by HMR client)
    // - Other files: 'full-reload'
		const isCSS = path.endsWith(".css");
		const isJS = /\.(jsx?|tsx?)$/.test(path);
		const updateType = (isCSS || isJS) ? "update" : "full-reload";

		const update: HMRUpdate = {
			"type": updateType,
			"path": path,
			"timestamp": Date.now()
		};

    // Emit event for ServerBridge
		this.emitHMRUpdate(update);

    // Send HMR update via postMessage (works with sandboxed iframes)
		if (this.hmrTargetWindow) {
			try {
				this.hmrTargetWindow.postMessage({ ...update, "channel": "vite-hmr" }, "*");
			} catch (e) {
        // Window may be closed or unavailable
			}
		}
	}

  /**
   * Stop the server
   */
	stop(): void {
		if (this.watcherCleanup) {
			this.watcherCleanup();
			this.watcherCleanup = null;
		}

		this.hmrTargetWindow = null;

		super.stop();
	}

  /**
   * Check if a file needs transformation
   */
	private needsTransform(path: string): boolean {
		return /\.(jsx|tsx|ts)$/.test(path);
	}

  /**
   * Transform and serve a JSX/TS file
   */
	private async transformAndServe(filePath: string, urlPath: string): Promise<ResponseData> {
		// A transform can transiently fail on the very first (cold) request for a module — e.g. the file isn't yet
		// visible in the worker's shared zen-fs, or the transform pipeline loses a cold-start race with a
		// near-simultaneous request for a sibling module. We deliberately do NOT retry that here: the only failure
		// mode that actually broke the preview was serving a bad module as a linkable 200 (see the 500 below), which
		// a browser caches — poisoning every importer's `import { X }` link permanently. Returning a 500 makes a cold
		// failure a self-healing transient (the browser re-fetches on the next load / reload) rather than a permanent
		// blank, so a retry buys nothing the 500 doesn't. We report every failure (see setTransformErrorReporter) so
		// a recurrence is visible in the observability plane instead of silently swallowed.
		try {
			const content = this.vfs.readFileSync(filePath, "utf8");
			const hash = simpleHash(content);

			// Serve a prior transform if the source is unchanged.
			const cached = this.transformCache.get(filePath);

			if (cached && cached.hash === hash && cached.level === this.instrumentLevel && cached.stops === this.stopsKey(filePath)) {
				const buffer = Buffer.from(await this.packages.rewriteImports(cached.code, urlPath, ts));

				return {
					"statusCode": 200,
					"statusMessage": "OK",
					"headers": {
						"Content-Type": "application/javascript; charset=utf-8",
						"Content-Length": String(buffer.length),
						"Cache-Control": "no-cache",
						"X-Transformed": "true",
						"X-Cache": "hit"
					},
					"body": buffer
				};
			}

			const transformed = await this.transformCode(content, urlPath, filePath);

			// Cache the transform result (before rewriting its bare imports: where they resolve follows package.json).
			this.transformCache.set(filePath, { "code": transformed, "hash": hash, "level": this.instrumentLevel, "stops": this.stopsKey(filePath) });

			const buffer = Buffer.from(await this.packages.rewriteImports(transformed, urlPath, ts));

			return {
				"statusCode": 200,
				"statusMessage": "OK",
				"headers": {
					"Content-Type": "application/javascript; charset=utf-8",
					"Content-Length": String(buffer.length),
					"Cache-Control": "no-cache",
					"X-Transformed": "true"
				},
				"body": buffer
			};
		} catch (error) {
			// Capture the failure's shape (which call threw, with what message + stack) so the transient cold-start
			// transform race — if it still exists — can be pinned from a real sample rather than inferred.
			const asError = error instanceof Error ? error : undefined;
			const info: TransformErrorInfo = {
				"url": urlPath,
				"name": asError?.name ?? typeof error,
				"message": asError?.message ?? String(error),
				"stack": asError?.stack
			};

			// Route through the reporter (the host worker wires it to its hub logger, so the failure is queryable in
			// the observability plane / debug-mcp); fall back to console.warn standalone.
			if (this.transformErrorReporter !== null) {
				this.transformErrorReporter(info);
			} else {
				console.warn("[ViteDevServer] transform failed:", info);
			}

			// Return 500, NOT a 200 whose body is an export-less error module: a 500 is a failed fetch the browser
			// retries on the next load and never caches as a linked module, whereas a 200 error-module links
			// successfully with no exports and permanently breaks every `import { X } from './that-module'` that
			// depends on it.
			console.error("[ViteDevServer] Transform error:", urlPath, error);

			return {
				"statusCode": 500,
				"statusMessage": "Transform Error",
				"headers": {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-cache",
					"X-Transform-Error": "true"
				},
				"body": Buffer.from(`Transform error for ${urlPath}: ${info.message}`)
			};
		}
	}

  /**
   * Transform JSX/TS code to browser-compatible JavaScript
   */
	private async transformCode(code: string, filename: string, filePath = filename): Promise<string> {
		if (!isBrowser) {
      // In test environment, just return code as-is
			return code;
		}

    // Transpile JSX/TS → browser ESM with the TypeScript compiler the editor already loads (no esbuild-wasm
    // CDN fetch). JsxEmit.ReactJSX is the React 17+ automatic runtime (imports from react/jsx-runtime), matching
    // the old esbuild jsx:'automatic' + jsxImportSource:'react'. Bare imports (react, …) are left intact and
    // resolved by the injected import map.
		// A workspace module (not a dependency's), instrumented for runtime evidence: its version is its source's blob oid.
		// One with a recorded stop is instrumented whatever the level (statements, at least: what the stop needs).
		const stops = filePath.includes("/node_modules/") ? undefined : this.stops.get(filePath);
		const level = this.instrumentLevel === "off" && stops !== undefined ? "coverage" : this.instrumentLevel;
		const instrumented = level === "off" || filePath.includes("/node_modules/") ? undefined : instrument(filePath, await blobOid(code), level, new Set(stops));
		const result = ts.transpileModule(code, {
			"fileName": filename,
			...instrumented === undefined ? {} : { "transformers": { "before": [instrumented.before] } },
			"compilerOptions": {
				"jsx": ts.JsxEmit.ReactJSX,
				"jsxImportSource": "react",
				"module": ts.ModuleKind.ESNext,
				"target": ts.ScriptTarget.ES2020,
				"inlineSourceMap": true,
				"inlineSources": true,
				"esModuleInterop": true,
				"useDefineForClassFields": true
			}
		});

		let output = result.outputText;

		if (instrumented !== undefined) {
			this.versions.set(await blobOid(code), { "file": filePath, "source": code });
			// The prelude is one line in front: the module's map moves down with its code.
			output = instrumented.prelude() + "\n" + shiftInlineSourceMap(output, 1);
		}

    // Add React Refresh registration for JSX/TSX files
		if (/\.(jsx|tsx)$/.test(filename)) {
			return this.addReactRefresh(output, filename);
		}

		return output;
	}

	private addReactRefresh(code: string, filename: string): string {
		return _addReactRefresh(code, filename);
	}

  /**
   * Serve CSS file as a JavaScript module that injects styles
   * This is needed because ES module imports of CSS files need to return JS
   */
	private serveCssAsModule(filePath: string): ResponseData {
		try {
			const css = this.vfs.readFileSync(filePath, "utf8");

      // Create JavaScript that injects the CSS into the document
			const js = `
// CSS Module: ${filePath}
const css = ${JSON.stringify(css)};
const style = document.createElement('style');
style.setAttribute('data-vite-dev-id', ${JSON.stringify(filePath)});
style.textContent = css;
document.head.appendChild(style);
export default css;
`;

			const buffer = Buffer.from(js);

			return {
				"statusCode": 200,
				"statusMessage": "OK",
				"headers": {
					"Content-Type": "application/javascript; charset=utf-8",
					"Content-Length": String(buffer.length),
					"Cache-Control": "no-cache"
				},
				"body": buffer
			};
		} catch (error) {
			return this.serverError(error);
		}
	}

  /**
   * Serve HTML file with HMR client script injected
   *
   * IMPORTANT: React Refresh preamble MUST be injected before any module scripts: its static import of the
   * runtime holds back every later module script until injectIntoGlobalHook has run, so React Refresh hooks into
   * React BEFORE React is imported by any module (see REACT_REFRESH_PREAMBLE).
   */
  /**
   * Build the import map from the workspace package.json dependencies — every declared dep resolves from esm.sh
   * at runtime (no install / no node_modules). react + react-dom get the `?dev` build the React-Refresh preamble
   * hooks; other deps get `?external=react,react-dom` so a component library shares the app's single React copy
   * rather than pulling its own. A missing/unparseable package.json still yields a working plain-React map.
   */
	private buildImportMap(): string {
		// The same declared deps rewritten imports resolve against (dependencies and devDependencies), so the two agree
		// on every version. No / invalid package.json: the react defaults below still let a plain React app run.
		const deps = this.packages.appDependencies();

		const reactVersion = deps.react ?? REACT_VERSION;
		const reactDomVersion = deps["react-dom"] ?? reactVersion;
		const imports: Record<string, string> = {
			"react": registryUrl("react", reactVersion, ""),
			"react/": registryUrl("react", reactVersion, "/"),
			"react-dom": registryUrl("react-dom", reactDomVersion, ""),
			"react-dom/": registryUrl("react-dom", reactDomVersion, "/")
		};

		for (const [name, version] of Object.entries(deps)) {
			// URL / tarball / file: / git deps aren't esm.sh's: bare imports of them are rewritten (see packages.ts).
			if (name === "react" || name === "react-dom" || !isRegistrySpec(version)) {
				continue;
			}

			imports[name] = registryUrl(name, version, "");
			imports[`${name}/`] = registryUrl(name, version, "/");
		}

		return `<script type="importmap">\n${JSON.stringify({ "imports": imports }, null, 2)}\n</script>`;
	}

	private serveHtmlWithHMR(filePath: string): ResponseData {
		try {
			let content = this.vfs.readFileSync(filePath, "utf8");

      // Inject an import map if the HTML doesn't already have one, built from the workspace package.json so any
      // declared dependency resolves from esm.sh at runtime — no `npm install` needed. This lets seed HTML omit
      // the esm.sh boilerplate; the platform provides it.
			if (!content.includes("\"importmap\"")) {
				const importMap = this.buildImportMap();

				if (content.includes("</head>")) {
					content = content.replace("</head>", `${importMap}\n</head>`);
				} else if (content.includes("<head>")) {
					content = content.replace("<head>", `<head>\n${importMap}`);
				}
			}

      // Inject React Refresh preamble before any app module scripts.
      // Firefox requires all <script type="importmap"> to appear before any <script type="module">,
      // so if the HTML contains an import map, inject AFTER the last one (not right after <head>).
			const importMapRegex = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
			let lastImportMapEnd = -1;
			let match;

			while ((match = importMapRegex.exec(content)) !== null) {
				lastImportMapEnd = match.index + match[0].length;
			}

			if (lastImportMapEnd !== -1) {
        // Insert preamble right after the last import map </script>
				content = content.slice(0, lastImportMapEnd) + REACT_REFRESH_PREAMBLE + content.slice(lastImportMapEnd);
			} else if (content.includes("<head>")) {
				content = content.replace("<head>", `<head>${REACT_REFRESH_PREAMBLE}`);
			} else if (content.includes("<html")) {
        // If no <head>, inject after <html...>
				content = content.replace(/<html[^>]*>/, `$&${REACT_REFRESH_PREAMBLE}`);
			} else {
        // Prepend if no html tag
				content = REACT_REFRESH_PREAMBLE + content;
			}

      // Inject HMR client script before </head> or </body>
			if (content.includes("</head>")) {
				content = content.replace("</head>", `${HMR_CLIENT_SCRIPT}</head>`);
			} else if (content.includes("</body>")) {
				content = content.replace("</body>", `${HMR_CLIENT_SCRIPT}</body>`);
			} else {
        // Append at the end if no closing tag found
				content += HMR_CLIENT_SCRIPT;
			}

			const buffer = Buffer.from(content);

			return {
				"statusCode": 200,
				"statusMessage": "OK",
				"headers": {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": String(buffer.length),
					"Cache-Control": "no-cache"
				},
				"body": buffer
			};
		} catch (error) {
			return this.serverError(error);
		}
	}
}

export default ViteDevServer;
