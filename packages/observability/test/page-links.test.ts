/**
 * How a page's hub reaches the rest (src/index.ts, src/arch-probes.ts), with the browser's few globals each one reads
 * stood in for: the service worker's hub linked over a port it's handed, and again when the worker asks; a preview's
 * page linked through its window's page tap, telling across the link to read its tools once the link is up; the page's
 * tools served on localhost and not elsewhere; and window messages counted as traffic between windows.
 */
import type { ArchSink, TrafficKind } from "../src/arch.ts";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, pipe } from "./hub.ts";
import { installWindowMessageProbe } from "../src/arch-probes.ts";
import { linkPreviewHost, linkServiceWorkerHub, servePageTools } from "../src/index.ts";
import { PAGE_TOOLS_CHANGED } from "../src/page-tools.ts";
import { until } from "./until.ts";

type Globals = Record<string, unknown>;

/** `values` as globals for the test, put back after it. */
function stand(t: { "after": (fn: () => void) => void }, values: Globals): void {
	const globals = globalThis as unknown as Globals;
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globals, key)]));

	for (const [key, value] of Object.entries(values)) {
		Object.defineProperty(globals, key, { "value": value, "configurable": true, "writable": true });
	}

	t.after(() => {
		for (const [key, descriptor] of Object.entries(saved)) {
			if (descriptor === undefined) {
				delete globals[key];
			} else {
				Object.defineProperty(globals, key, descriptor);
			}
		}
	});
}

test("the service worker's hub is linked over a port handed to it, and again when a restarted worker asks", (t) => {
	const posted: { "type": string; "port": unknown }[] = [];
	const listeners = new Map<string, (event: { "data": unknown }) => void>();
	const serviceWorker = {
		"controller": { "postMessage": (message: { "type": string; "port": unknown }) => { posted.push(message); } },
		"addEventListener": (type: string, listener: (event: { "data": unknown }) => void) => { listeners.set(type, listener); }
	};

	stand(t, { "navigator": { "serviceWorker": serviceWorker } });

	const hub = createHub({ "id": "page" });

	linkServiceWorkerHub(hub);
	assert.deepEqual(posted.map(({ type, port }) => [type, port instanceof MessagePort]), [["hub", true]], "a port, for the worker's end of the link");

	listeners.get("message")?.({ "data": { "type": "sw-needs-hub" } });
	listeners.get("message")?.({ "data": { "type": "something else" } });
	assert.equal(posted.length, 2, "a worker that restarted (a fresh, unlinked hub) asks, and is linked again");

	for (const { port } of posted) {
		(port as MessagePort).close();
	}
});

test("a preview's page links through its window's page tap, and once up, tells across the link to read its tools", async (t) => {
	const [page, editor] = pipe();
	const fake = { "parent": undefined as unknown, "opener": {} };

	fake.parent = fake;
	stand(t, { "window": fake, "location": { "pathname": "/__virtual__/app/5173/", "origin": "http://localhost:5173" }, "__editorTap": { "window": "preview:5173~1", "connect": () => page } });

	const told: unknown[] = [];
	const editorHub = createHub({ "id": "editor" });

	editorHub.subscribe(PAGE_TOOLS_CHANGED, (data) => {
		told.push(data);
	});
	editorHub.link(editor);

	const appHub = createHub({ "id": "app" });
	const link = linkPreviewHost(appHub);

	assert.ok(link !== undefined, "a preview's top frame has a host");
	assert.equal(await link.ready, true);
	await until("the page's tools, announced across the link once it's up", () => told.length > 0);
	link();
});

test("the page's tools are served where debugging is on — localhost — and not on another origin", (t) => {
	stand(t, { "location": { "hostname": "example.com", "search": "", "pathname": "/" }, "localStorage": { "getItem": () => null } });
	assert.equal(servePageTools(createHub({ "id": "elsewhere" })), undefined, "a visitor's tab serves nothing");

	(globalThis as unknown as Globals)["location"] = { "hostname": "localhost", "search": "", "pathname": "/" };

	const tab = servePageTools(createHub({ "id": "local" }), { "tab": "t1" });

	assert.equal(tab, "t1");
});

test("a message from another window is counted as traffic between windows, its ports said; this window's own and a pane's link aren't", (t) => {
	const recorded: [string, string, TrafficKind, string][] = [];
	const sink = { "self": "shell", "record": (from: string, to: string, kind: TrafficKind, label: string) => { recorded.push([from, to, kind, label]); } } as unknown as ArchSink;
	let listener: ((event: unknown) => void) | undefined;
	const fake = { "addEventListener": (_type: string, handler: (event: unknown) => void) => { listener = handler; } };
	const other = { "postMessage": () => undefined };

	stand(t, { "window": fake });
	installWindowMessageProbe(sink, (source) => (source === other as unknown ? "preview" : undefined));

	listener?.({ "data": { "type": "ping" }, "source": other, "ports": [] });
	listener?.({ "data": { "type": "hello" }, "source": other, "ports": [{}] });
	listener?.({ "data": { "type": "mine" }, "source": fake, "ports": [] });
	listener?.({ "data": { "\0paneLink": true }, "source": other, "ports": [] });
	listener?.({ "data": "from nowhere", "source": null, "ports": [] });

	assert.equal(recorded.length, 2);
	assert.deepEqual(recorded.map(([from, to]) => [from, to]), [["preview", "shell"], ["preview", "shell"]]);
	assert.match(recorded[1][3], /\(\+MessagePort\)$/u, "a message carrying a port says so");
});
