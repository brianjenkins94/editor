/**
 * The editor on a plain static host: the service worker that gives it cross-origin isolation, serves package files
 * from the CDN and answers previews (coi-serviceworker.js), built beside the site, and the files a host reads to serve
 * the site well.
 */
import type { Logger, Plugin } from "vite";
import * as url from "node:url";
import { buildPackage } from "@brianjenkins94/util/vite/build";

/** The COI service worker (→ docs/coi-serviceworker.js), a single-file ES module. */
export async function buildServiceWorker(root: string, logger: Logger): Promise<void> {
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"build": {
			"outDir": "../../docs",
			"emptyOutDir": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "coi-serviceworker": url.fileURLToPath(new URL("../coi-serviceworker.js", import.meta.url)) },
				"output": { "codeSplitting": false }
			}
		}
	});
}

/**
 * What a static host needs to serve the site well, beside it. The production site (packages/site/editor.jsonc, Workers
 * static assets) reads `_headers` — real cross-origin isolation headers, so the first load needn't wait for the service
 * worker to stamp them — `_redirects`, which serves the editor's page at every `env/<owner>/<repo>` (shell/address.ts), and
 * `.assetsignore`: the package tarballs are the releases' and Pages', not the site's, and source maps are kept apart; and
 * `robots.txt`, turning crawlers away. GitHub Pages reads none of them;
 * there `404.html` is the editor's page, so a deep link opens the editor (with a 404 status, which the page doesn't mind).
 */
export function staticHostPlugin(): Plugin {
	return {
		"name": "static-host",
		"enforce": "post",
		"generateBundle": function(_options, bundle) {
			const index = bundle["index.html"];

			if (index?.type === "asset") {
				this.emitFile({ "type": "asset", "fileName": "404.html", "source": index.source });
			}

			// frame-ancestors 'self': the shell is the editor's only embedder. Another site framing it could navigate the frames
			// inside it, such as the DevTools frame the shell posts to with "*" (shell/preview-devtools.ts).
			this.emitFile({ "type": "asset", "fileName": "_headers", "source": ["/*", "  Cross-Origin-Opener-Policy: same-origin", "  Cross-Origin-Embedder-Policy: credentialless", "  Content-Security-Policy: frame-ancestors 'self'", "  X-Content-Type-Options: nosniff", ""].join("\n") });
			// html_handling is "none" (editor.jsonc: no 307 from `x.html` to `x`), so the root names index.html itself. Named
			// placeholders, not `/env/*`: a splat rewrite 404s under "none".
			this.emitFile({ "type": "asset", "fileName": "_redirects", "source": ["/ /index.html 200", "/env/:owner/:repo /index.html 200", "/env/:owner/:repo/ /index.html 200", ""].join("\n") });
			this.emitFile({ "type": "asset", "fileName": ".assetsignore", "source": "packages/\n*.map\n" });
			// Crawlers that ask are sent to the root domain, which asks them to pay (packages/site/src/gate.ts); the editor stays
			// static files with no Worker in front, so it can't. Pages serves this at /editor/robots.txt, where nobody looks.
			this.emitFile({ "type": "asset", "fileName": "robots.txt", "source": "User-agent: *\nDisallow: /\n" });
		}
	};
}
