/**
 * The metrics plane's names for realms (shared/editor-metrics.ts `realmName`): memory as the browser attributes it — by
 * a realm's URL — named as the editor's realms are, a worker the architecture store named first by its own name
 * (`workerNames`); and, before the first measurement, this window's heap (`thisWindow`).
 *
 *   node --import tsx --test test/editor-metrics.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { realmName, realmsOf, thisWindow, workerNames } = await import("../shared/editor-metrics.ts");

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

test("a memory measurement, by realm: each window's and worker's bytes, a realm measured in parts added up, what's shared left out (realmsOf, for the run's DevTools endpoint)", () => {
	const measurement = {
		"bytes": 60,
		"breakdown": [
			{ "bytes": 30, "attribution": [{ "url": "http://localhost:5173/__vscode__/host.html", "scope": "Window" }] },
			{ "bytes": 5, "attribution": [{ "url": "http://localhost:5173/__vscode__/host.html", "scope": "Window" }] },
			{ "bytes": 20, "attribution": [{ "url": "http://localhost:5173/debug-worker.js", "scope": "DedicatedWorkerGlobalScope" }] },
			{ "bytes": 5, "attribution": [] }
		]
	};

	assert.deepEqual(realmsOf(measurement), [
		{ "url": "http://localhost:5173/__vscode__/host.html", "scope": "Window", "bytes": 35 },
		{ "url": "http://localhost:5173/debug-worker.js", "scope": "DedicatedWorkerGlobalScope", "bytes": 20 }
	]);
});

test("each worker the architecture store knows, by its URL, named as the store names it: the extension host, a label, an id's own name", () => {
	const node = (label, url) => ({ "spec": { ...label === undefined ? {} : { "label": label }, "meta": url === undefined ? {} : { "url": url } } });
	const store = { "nodes": new Map([
		["exthost:LocalWebWorker:1", node("whatever", `${SITE}/ext-host.js#1`)],
		["worker:debug-worker.js #2", node(undefined, `${SITE}/__vscode__/lsp/debug-worker.js`)],
		["nested:packages-worker.js", node(undefined, `${SITE}/__vscode__/lsp/packages-worker.js`)],
		["ext:eslint/eslint-server", node("eslint server #3", `${SITE}/__vscode__/eslint.js`)],
		["shell", node("shell", undefined)]
	]) };

	assert.deepEqual(Object.fromEntries(workerNames(store)), {
		[`${SITE}/ext-host.js`]: "extension host",
		[`${SITE}/__vscode__/lsp/debug-worker.js`]: "debug-worker",
		[`${SITE}/__vscode__/lsp/packages-worker.js`]: "packages-worker",
		[`${SITE}/__vscode__/eslint.js`]: "eslint server"
	});
	assert.equal(realmName(`${SITE}/__vscode__/lsp/packages-worker.js`, "DedicatedWorkerGlobalScope", workerNames(store)), "packages-worker", "and the memory gauge names a realm by it");
});

test("before the first measurement, the realms a run's DevTools endpoint asks for are this window's, where the browser says its heap; none where it doesn't", () => {
	assert.equal(thisWindow(), undefined, "Node has no performance.memory");

	const { memory } = performance;

	Object.defineProperty(performance, "memory", { "value": { "usedJSHeapSize": 1234 }, "configurable": true });
	globalThis.location = { "href": `${SITE}/` };

	try {
		assert.deepEqual(thisWindow()?.realms, [{ "url": `${SITE}/`, "scope": "Window", "bytes": 1234 }]);
	} finally {
		Object.defineProperty(performance, "memory", { "value": memory, "configurable": true });
		delete globalThis.location;
	}
});
