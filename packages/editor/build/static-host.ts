import type { Logger, Plugin } from "vite";
import * as url from "node:url";

export async function buildServiceWorker(root: string, logger: Logger): Promise<void> {
	const { buildPackage } = await import("@brianjenkins94/util/vite/build");

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

export function staticHostPlugin(): Plugin {
	return {
		"name": "static-host",
		"enforce": "post",
		"generateBundle": function(_options, bundle) {
			const index = bundle["index.html"];

			if (index?.type === "asset") {
				this.emitFile({ "type": "asset", "fileName": "404.html", "source": index.source });
			}

			this.emitFile({ "type": "asset", "fileName": "_headers", "source": ["/*", "  Cross-Origin-Opener-Policy: same-origin", "  Cross-Origin-Embedder-Policy: credentialless", "  Content-Security-Policy: frame-ancestors 'self'", "  X-Content-Type-Options: nosniff", ""].join("\n") });
			this.emitFile({ "type": "asset", "fileName": "_redirects", "source": ["/ /index.html 200", "/env/:owner/:repo /index.html 200", "/env/:owner/:repo/ /index.html 200", ""].join("\n") });
			this.emitFile({ "type": "asset", "fileName": ".assetsignore", "source": "packages/\n*.map\n" });
			this.emitFile({ "type": "asset", "fileName": "robots.txt", "source": "User-agent: *\nDisallow: /\n" });
		}
	};
}
