/* eslint-disable ts/no-unused-private-class-members, regexp/no-contradiction-with-assertion -- vendored fork of macaly/almostnode — upstream/runtime idioms kept close to source, not restyled to this repo rules */
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
import { addReactRefresh as _addReactRefresh } from "./code-transforms";

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

/**
 * React Refresh preamble - MUST run before React is loaded
 * This script is blocking to ensure injectIntoGlobalHook runs first
 */
const REACT_REFRESH_PREAMBLE = `
<script type="module">
// Block until React Refresh is loaded and initialized
// This MUST happen before React is imported
const RefreshRuntime = await import('${REACT_REFRESH_CDN}').then(m => m.default || m);

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

  // Handle JS/JSX module updates
  async function handleJSUpdate(path, timestamp) {
    // Normalize path to match module keys
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const hot = hotModules.get(normalizedPath);

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

export class ViteDevServer extends DevServer {
	private watcherCleanup: (() => void) | null = null;
	private readonly options: ViteDevServerOptions;
	private hmrTargetWindow: Window | null = null;
	private readonly transformCache = new Map<string, { "code": string; "hash": string }>();

	constructor(vfs: VirtualFS, options: ViteDevServerOptions) {
		super(vfs, options);
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

    // Serve static file
		return this.serveFile(filePath);
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
		// near-simultaneous request for a sibling module. Retry a few times so the FIRST response is still a correct
		// module: the failure mode we must avoid is serving a bad module as a linkable 200 (see the 500 below), which
		// a browser caches — poisoning every importer's `import { X }` link permanently until a manual reload.
		let lastError: unknown;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				const content = this.vfs.readFileSync(filePath, "utf8");
				const hash = simpleHash(content);

        // Check transform cache (a concurrent request may have populated it between our attempts)
				const cached = this.transformCache.get(filePath);

				if (cached && cached.hash === hash) {
					const buffer = Buffer.from(cached.code);

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

				const transformed = await this.transformCode(content, urlPath);

        // Cache the transform result
				this.transformCache.set(filePath, { "code": transformed, "hash": hash });

				const buffer = Buffer.from(transformed);

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
				lastError = error;

				// Log the FIRST failure even when a retry then recovers it: this is the transient cold-start
				// transform race, and capturing its shape (which call threw, with what message + stack) is the only
				// way to pin the actual source rather than infer it. Kept as a warn (not an error) since the retry
				// usually succeeds and the request still returns a correct module.
				if (attempt === 0) {
					const asError = error instanceof Error ? error : undefined;

					console.warn("[ViteDevServer] transform failed on first attempt (will retry):", urlPath, {
						"name": asError?.name ?? typeof error,
						"message": asError?.message ?? String(error),
						"stack": asError?.stack
					});
				}

				// Brief backoff, then retry — recovers the cold-start race within this single request.
				await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
			}
		}

		// Retries exhausted → treat as a genuine failure (e.g. a real syntax error in the source). Return 500, NOT a
		// 200 whose body is an export-less error module: a 500 is a failed fetch the browser retries on the next load
		// and never caches as a linked module, whereas a 200 error-module links successfully with no exports and
		// permanently breaks every `import { X } from './that-module'` that depends on it.
		const message = lastError instanceof Error ? lastError.message : "Transform failed";

		console.error("[ViteDevServer] Transform error (after retries):", urlPath, lastError);

		return {
			"statusCode": 500,
			"statusMessage": "Transform Error",
			"headers": {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-cache",
				"X-Transform-Error": "true"
			},
			"body": Buffer.from(`Transform error for ${urlPath}: ${message}`)
		};
	}

  /**
   * Transform JSX/TS code to browser-compatible JavaScript
   */
	private async transformCode(code: string, filename: string): Promise<string> {
		if (!isBrowser) {
      // In test environment, just return code as-is
			return code;
		}

    // Transpile JSX/TS → browser ESM with the TypeScript compiler the editor already loads (no esbuild-wasm
    // CDN fetch). JsxEmit.ReactJSX is the React 17+ automatic runtime (imports from react/jsx-runtime), matching
    // the old esbuild jsx:'automatic' + jsxImportSource:'react'. Bare imports (react, …) are left intact and
    // resolved by the injected import map.
		const result = ts.transpileModule(code, {
			"fileName": filename,
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

    // Add React Refresh registration for JSX/TSX files
		if (/\.(jsx|tsx)$/.test(filename)) {
			return this.addReactRefresh(result.outputText, filename);
		}

		return result.outputText;
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
   * IMPORTANT: React Refresh preamble MUST be injected before any module scripts.
   * The preamble uses top-level await to block until React Refresh is loaded
   * and injectIntoGlobalHook is called. This ensures React Refresh hooks into
   * React BEFORE React is imported by any module.
   */
  /**
   * Build the import map from the workspace package.json dependencies — every declared dep resolves from esm.sh
   * at runtime (no install / no node_modules). react + react-dom get the `?dev` build the React-Refresh preamble
   * hooks; other deps get `?external=react,react-dom` so a component library shares the app's single React copy
   * rather than pulling its own. A missing/unparseable package.json still yields a working plain-React map.
   */
	private buildImportMap(): string {
		let deps: Record<string, string> = {};

		try {
			const pkgPath = this.root === "/" ? "/package.json" : `${this.root}/package.json`;
			const parsed = JSON.parse(this.vfs.readFileSync(pkgPath, "utf8") as string) as { "dependencies"?: Record<string, string> };

			deps = { ...parsed.dependencies };
		} catch {
      // No / invalid package.json — the react defaults below still let a plain React app run.
		}

		const base = (name: string, version: string): string => `https://esm.sh/${name}@${version}`;
		const reactVersion = deps.react ?? REACT_VERSION;
		const reactDomVersion = deps["react-dom"] ?? reactVersion;
		const reactUrl = base("react", reactVersion);
		const reactDomUrl = base("react-dom", reactDomVersion);
		const imports: Record<string, string> = {
			"react": `${reactUrl}?dev`,
			"react/": `${reactUrl}&dev/`,
			"react-dom": `${reactDomUrl}?dev`,
			"react-dom/": `${reactDomUrl}&dev/`
		};

		for (const [name, version] of Object.entries(deps)) {
			if (name === "react" || name === "react-dom") {
				continue;
			}

			imports[name] = `${base(name, version)}?external=react,react-dom`;
			imports[`${name}/`] = `${base(name, version)}&external=react,react-dom/`;
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
