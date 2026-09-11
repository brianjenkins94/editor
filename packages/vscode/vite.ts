/**
 * Serves the VS Code workbench for the iframe in `vscode.tsx`.
 *
 * The iframe loads `<base>/__vscode__/host.html`, a minimal page that pulls in the composed entry
 * `workbench.js` (built from workbench-entry.tsx into this package's `dist/` by entry.config.ts),
 * which renders <Workbench/> and boots the monaco component's `main.js`. So `/__vscode__/` is served
 * from two roots: this package's `dist/` (host entry) and the LOCAL monaco-vscode-api component's
 * `dist/` (main.js + chunks + worker/wasm/font assets + monaco's own webview index.html). The host
 * app supplies cross-origin isolation (SharedArrayBuffer); this plugin only serves files (with COEP so
 * the iframe inherits it).
 *
 * The monaco dist is resolved by RELATIVE PATH to editor's own `components/monaco-vscode-api/dist`
 * (not the published lib tarball) — editor owns that component now.
 */
import type { Plugin } from "vite";
// eslint-disable-next-line ts/no-restricted-imports -- the dev-server middleware answers synchronously, so mapping a request to a file must stat synchronously
import { statSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { find } from "@brianjenkins94/util/find";
import * as fs from "@brianjenkins94/util/fs";
import { fromProxyPath } from "./proxy";

const MOUNT = "/__vscode__/";

// Minimal iframe host page: the grid/layout lives in the <Workbench/> component (stitches), so this
// just resets the document and loads the workbench entry bundle.
const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>monaco-vscode-api</title>
	<style>html, body { height: 100%; margin: 0; overflow: hidden; }</style>
</head>
<body>
	<script type="module" src="./workbench.js"></script>
</body>
</html>
`;

const CONTENT_TYPES: Record<string, string> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".html": "text/html",
	".json": "application/json",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".png": "image/png",
	".svg": "image/svg+xml"
};

/** The local monaco-vscode-api component's built bundle dir (main.js + chunks + wasm/fonts). */
function componentDistDirectory(): string {
	return url.fileURLToPath(new URL("../../components/monaco-vscode-api/dist", import.meta.url));
}

/**
 * Dev-only half of the `__proxy__` convention (proxy.ts). In production the COI service worker fetches the
 * real CDN URL and re-serves it same-origin; in dev no service worker runs (the page is isolated by the
 * coi-headers middleware directly), so this middleware does the same job — match `…/__proxy__/<host>/<path>`,
 * fetch the real https URL, and pipe it back. The node_modules overlay hits this uniformly in both modes.
 */
export function proxyPlugin(): Plugin {
	return {
		"name": "cdn-proxy",

		"configureServer": function(server) {
			server.middlewares.use((req, res, next) => {
				const realUrl = fromProxyPath(req.url ?? "");

				if (realUrl === undefined) {
					next();

					return;
				}

				fetch(realUrl).then(async (upstream) => {
					const body = Buffer.from(await upstream.arrayBuffer());
					const contentType = upstream.headers.get("content-type");

					res.statusCode = upstream.status;

					if (contentType !== null) {
						res.setHeader("content-type", contentType);
					}

					res.setHeader("cache-control", "no-cache");
					// Same-origin to the isolated iframe (no CORP strictly needed), but set it to match the prod SW.
					res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
					res.end(body);
				}).catch((error: unknown) => {
					res.statusCode = 502;
					res.end("proxy error: " + (error instanceof Error ? error.message : "unknown"));
				});
			});
		}
	};
}

export function vscodePlugin(): Plugin {
	const componentDist = componentDistDirectory();
	const workbenchDist = url.fileURLToPath(new URL("./dist", import.meta.url));
	// Workbench entry first (host/workbench), then the component bundle (main.js + assets).
	const roots = [workbenchDist, componentDist];

	const resolveFile = (relative: string): string | undefined => {
		for (const root of roots) {
			const file = path.join(root, relative);

			if (file.startsWith(root) && fs.existsSync(file) && statSync(file).isFile()) {
				return file;
			}
		}

		return undefined;
	};

	return {
		"name": "vscode-workbench",

		"configureServer": function(server) {
			server.middlewares.use((req, res, next) => {
				const [url] = (req.url ?? "").split("?");
				const index = url.indexOf(MOUNT); // tolerate any base prefix (e.g. /editor/)

				if (index === -1) {
					next();

					return;
				}

				const relative = url.slice(index + MOUNT.length);

				// The workbench needs SharedArrayBuffer, so this iframe's document must be
				// cross-origin isolated too — it inherits isolation from the (isolated) host page
				// only if its own responses carry COEP. Match the host's `credentialless` mode.
				res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

				if (relative === "" || relative === "host.html") {
					res.setHeader("content-type", "text/html");
					res.end(HOST_HTML);

					return;
				}

				const file = resolveFile(relative);

				if (file !== undefined) {
					res.setHeader("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
					res.end(fs.readFileSync(file, { "encoding": null })); // bytes: wasm/fonts, not text

					return;
				}

				next();
			});
		},

		"generateBundle": async function() {
			this.emitFile({ "type": "asset", "fileName": "__vscode__/host.html", "source": HOST_HTML });

			const emitted = new Set(["host.html"]);

			// Roots stay sequential so the dedupe below sees the workbench entry before the component; within one root paths are unique.
			for (const root of roots) {
				await find(root).type("f").exec(async (absolute) => {
					const relative = path.relative(root, absolute).split(path.sep).join("/");

					if (emitted.has(relative)) {
						return; // workbench entry wins over component on conflict
					}

					emitted.add(relative);
					this.emitFile({
						"type": "asset",
						"fileName": path.posix.join("__vscode__", relative),
						"source": await fs.readFile(absolute, { "encoding": null }) // bytes: wasm/fonts, not text
					});
				});
			}
		}
	};
}
