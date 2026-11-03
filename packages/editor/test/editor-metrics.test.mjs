/**
 * The metrics plane's names for realms (shared/editor-metrics.ts `realmName`): memory as the browser attributes it — by
 * a realm's URL — named as the editor's realms are, a worker the architecture store named first by its own name.
 *
 *   node --import tsx --test test/editor-metrics.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { realmName } = await import("../shared/editor-metrics.ts");

const SITE = "http://localhost:5173";

test("a realm's name from its URL: the workbench, the debug worker, the extension host's frame, the page", () => {
	assert.equal(realmName(`${SITE}/__vscode__/host.html?pane=a`, "Window"), "workbench");
	assert.equal(realmName(`${SITE}/__vscode__/lsp/debug-worker.js`, "DedicatedWorkerGlobalScope"), "debug-worker");
	assert.equal(realmName(`${SITE}/__vscode__/webWorkerExtensionHostIframe.html`, "Window"), "exthost-iframe");
	assert.equal(realmName(`${SITE}/env/someone/repo`, "Window"), "page", "the shell and the app frame share the page's");
	assert.equal(realmName(`${SITE}/__vscode__/assets/something.worker.js`, "DedicatedWorkerGlobalScope"), "something.worker.js");
});

test("a worker the store named is called that; a blob or a URL that isn't one is an unnamed worker", () => {
	const workers = new Map([[`${SITE}/__vscode__/assets/tsserver.web.js`, "TS semantic server"]]);

	assert.equal(realmName(`${SITE}/__vscode__/assets/tsserver.web.js#fragment`, "DedicatedWorkerGlobalScope", workers), "TS semantic server");
	assert.equal(realmName("blob:http://localhost:5173/1234", "DedicatedWorkerGlobalScope"), "unnamed workers");
	assert.equal(realmName("not a url", "DedicatedWorkerGlobalScope"), "unnamed workers");
	assert.equal(realmName("not a url", ""), "shared");
});
