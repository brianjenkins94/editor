/**
 * What a static host serves beside the editor (build/static-host.ts `staticHostPlugin`): the editor's page again as
 * 404.html (Pages: a deep link opens the editor), `_headers` — cross-origin isolation from the first load, the frame
 * ancestors, no sniffing — `_redirects`, the editor's page at every env/<owner>/<repo>, `.assetsignore` and robots.txt.
 * workbench.mjs sees the service worker the site runs with.
 *
 *   node --import tsx --test test/static-host.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { staticHostPlugin } = await import("../build/static-host.ts");

/** What the plugin emits beside a bundle holding `index.html`: by file name. */
function emitted() {
	const files = {};

	staticHostPlugin().generateBundle.call({
		"emitFile": ({ fileName, source }) => {
			files[fileName] = source;
		}
	}, {}, { "index.html": { "type": "asset", "source": "<!doctype html><title>editor</title>" } });

	return files;
}

test("the site's files: 404.html is the editor's page, isolation and frame ancestors as headers, env/ addresses rewritten", () => {
	const files = emitted();

	assert.deepEqual(Object.keys(files).toSorted(), [".assetsignore", "404.html", "_headers", "_redirects", "robots.txt"]);
	assert.equal(files["404.html"], "<!doctype html><title>editor</title>");

	const headers = files["_headers"].split("\n");

	assert.equal(headers[0], "/*");

	for (const header of ["Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Embedder-Policy: credentialless", "Content-Security-Policy: frame-ancestors 'self'", "X-Content-Type-Options: nosniff"]) {
		assert.ok(headers.includes("  " + header), header);
	}

	assert.deepEqual(files["_redirects"].trim().split("\n"), ["/ /index.html 200", "/env/:owner/:repo /index.html 200", "/env/:owner/:repo/ /index.html 200"]);
	assert.deepEqual(files[".assetsignore"].trim().split("\n"), ["packages/", "*.map"]);
	assert.match(files["robots.txt"], /^User-agent: \*\nDisallow: \/\n$/u);
});

test("a bundle without the page emits no 404.html", () => {
	const files = {};

	staticHostPlugin().generateBundle.call({ "emitFile": ({ fileName, source }) => { files[fileName] = source; } }, {}, {});

	assert.equal("404.html" in files, false);
	assert.ok("_headers" in files);
});
