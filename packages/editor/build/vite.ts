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
import * as path from "node:path";
import * as url from "node:url";
import { find } from "@brianjenkins94/util/find";
import * as fs from "@brianjenkins94/util/fs";

const MOUNT = "/__vscode__/";

// Minimal iframe host page: the grid/layout lives in the <Workbench/> component (stitches), so this
// just resets the document and loads the workbench entry bundle.
/** The component chunks main.js imports statically (transitively): the browser only discovers them once main.js has
 *  downloaded and parsed, so the host page preloads them alongside it. */
function componentStaticChunks(componentDist: string): string[] {
	const seen = new Set<string>();
	const pending = ["main.js"];

	while (pending.length > 0) {
		const file = pending.pop();

		if (!seen.has(file) && fs.existsSync(path.join(componentDist, file))) {
			seen.add(file);

			for (const match of fs.readFileSync(path.join(componentDist, file)).matchAll(/(?:^|[;}\s])(?:import|export)(?:[\w${}*,\s]+from\s*|\s*)["'](\.\/[^"']+\.js)["']/gu)) {
				pending.push(path.posix.normalize(match[1]));
			}
		}
	}

	seen.delete("main.js");

	return [...seen].sort();
}

function hostHtml(componentDist: string): string {
	// eslint-disable-next-line webawesome/no-html-in-strings -- one preload line of the host document (below)
	const preloads = componentStaticChunks(componentDist).map((chunk) => `\t<link rel="modulepreload" href="./${chunk}" />\n`).join("");

	// eslint-disable-next-line webawesome/no-css-in-strings -- the iframe HOST DOCUMENT served to bootstrap the workbench (a full HTML page + its reset CSS, as text), not app chrome
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>monaco-vscode-api</title>
	<style>html, body { height: 100%; margin: 0; overflow: hidden; }</style>
	<!-- perf: fetch the workbench entry, the component's main.js AND every chunk main.js imports statically, in
	     parallel the moment this document parses — rather than serially (workbench.js → discover main.js → download
	     and parse main.js → discover its chunks). modulepreload also starts their parse/compile early. -->
	<link rel="modulepreload" href="./workbench.js" />
	<link rel="modulepreload" href="./main.js" />
${preloads}</head>
<body>
	<script type="module" src="./workbench.js"></script>
</body>
</html>
`;
}

/**
 * Preload the workbench's boot chunks from the site's index.html, so they download while the shell and the app iframe
 * are still starting — before the workbench iframe that imports them even exists. A plain `preload` (fetch only: no
 * parse or compile in this document, which shares the iframes' main thread); the iframe then gets them from the HTTP
 * cache. BUILD only: the dev server sends no cache headers, so the iframe couldn't reuse them there.
 */
export function workbenchPreloadPlugin(): Plugin {
	return {
		"name": "workbench-preload",
		"apply": "build",
		"transformIndexHtml": () => ["workbench.js", "main.js", ...componentStaticChunks(componentDistDirectory())].map((file) => ({
			"tag": "link",
			// Low priority: on a warm load these are ~14MB of cache reads that would otherwise delay the shell's own files.
			"attrs": { "rel": "preload", "as": "script", "crossorigin": "", "fetchpriority": "low", "href": MOUNT.slice(1) + file },
			"injectTo": "head" as const
		}))
	};
}

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
	return url.fileURLToPath(new URL("../../../components/monaco-vscode-api/dist", import.meta.url));
}

export function vscodePlugin(): Plugin {
	const componentDist = componentDistDirectory();
	const workbenchDist = url.fileURLToPath(new URL("../dist", import.meta.url));
	// Workbench entry first (host/workbench), then the component bundle (main.js + assets).
	const roots = [workbenchDist, componentDist];

	const resolveFile = (relative: string): string | undefined => {
		for (const root of roots) {
			const file = path.join(root, relative);

			if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
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
					res.end(hostHtml(componentDist));

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
			this.emitFile({ "type": "asset", "fileName": "__vscode__/host.html", "source": hostHtml(componentDist) });

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
