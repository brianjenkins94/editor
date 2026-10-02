/**
 * Who a record is from (tagBySubject), what an untrusted peer may publish (observabilityPermissions), and owning a
 * worker's errors once (ownWorker).
 */
import type { LogRecord } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";

import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import { installHubCollector, observabilityPermissions, ownWorker, scopedTransport } from "../src/index.ts";
import { sourceOfLogSubject, tagBySubject } from "../src/log-subject.ts";
import { until } from "./until.ts";

/** A few timer turns: what's in flight goes a few hops further — for checking nothing ELSE arrived. To wait for something
 *  that should, `until`. */
async function flush(): Promise<void> {
	for (let round = 0; round < 5; round += 1) {
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	}
}

test("a record is tagged with the source its subject names, whatever it claims", () => {
	assert.equal(sourceOfLogSubject("$sys.log.client-0"), "client-0");
	assert.equal(sourceOfLogSubject("$sys.log."), undefined);
	assert.equal(sourceOfLogSubject("$sys.arch.page"), undefined);
	assert.deepEqual(tagBySubject({ "message": "m", "context": { "source": "referee", "tab": "t" } }, "$sys.log.client-0"), { "message": "m", "context": { "source": "client-0", "tab": "t" } });
	assert.deepEqual(tagBySubject({ "message": "no context" }, "$sys.log.client-0"), { "message": "no context", "context": { "source": "client-0" } });

	const honest = { "context": { "source": "page" } };

	assert.equal(tagBySubject(honest, "$sys.log.page"), honest, "an honest record passes as it is");
	assert.equal(tagBySubject("text", "$sys.log.page"), "text");
});

test("the edge names: whatever subject or source a peer logs under, it's filed under its scope", async () => {
	const [up, down] = pipe();
	const root = createHub({ "id": "root" });
	const client = createHub({ "id": "client" });
	const records: LogRecord[] = [];

	installHubCollector(root, (record) => { records.push(record); });
	await Promise.all([root.link(scopedTransport(up, "client-0", { "keep": (id) => id === "root" }), { "peer": "client-0", "permissions": observabilityPermissions() }).ready, client.link(down).ready]);
	await until("the collector's interest at the client", () => client.interested("$sys.log.client"));

	const record = (source: string, message: string) => ({ "kind": "log", "level": "info", "message": message, "context": { "source": source }, "time": 0, "depth": 0 });

	// On its own subject, claiming to be the referee: it's the scope itself.
	client.publish("$sys.log.client", record("referee", "lying"));
	// On a subject already under its scope (its instance page names itself so): as it is.
	client.publish("$sys.log.client-0/ui", record("client-0/ui", "its page"));
	// On another's subject: under its scope all the same — never the referee's.
	client.publish("$sys.log.referee", record("referee", "spoofed"));
	await until("all three records", () => records.length >= 3);

	assert.deepEqual(records.map((entry) => [entry.context?.["source"], entry.message]), [["client-0", "lying"], ["client-0/ui", "its page"], ["client-0/referee", "spoofed"]]);
});

test("observabilityPermissions: logs, backlogs, reports and metrics out, the viewers' sync in — nothing else either way", async () => {
	const [up, down] = pipe();
	const root = createHub({ "id": "root" });
	const peer = createHub({ "id": "p" });
	const heard: string[] = [];
	const told: string[] = [];

	root.subscribe(">", (_data, envelope) => { heard.push(envelope.subject); });
	peer.subscribe(">", (_data, envelope) => { told.push(envelope.subject); });
	await Promise.all([root.link(up, { "peer": "p", "permissions": observabilityPermissions() }).ready, peer.link(down).ready]);
	await until("each side's interest at the other", () => peer.interested("$sys.log.p") && root.interested("$sys.arch.sync"));

	for (const subject of ["$sys.log.p", "$sys.log.p/ui", "$sys.arch.p", "$sys.metrics.p", "$sys.backlog.log", "$sys.other", "game.move"]) {
		peer.publish(subject, {});
	}

	for (const subject of ["$sys.arch.sync", "$sys.log.root", "game.state"]) {
		root.publish(subject, {});
	}

	await until("what each may send", () => heard.includes("$sys.backlog.log") && told.includes("$sys.arch.sync"));
	await flush(); // and what each may not, its chance to arrive

	assert.deepEqual(heard.filter((subject) => !["$sys.arch.sync", "$sys.log.root", "game.state"].includes(subject)), ["$sys.log.p", "$sys.log.p/ui", "$sys.arch.p", "$sys.metrics.p", "$sys.backlog.log"]);
	assert.deepEqual(told.filter((subject) => !["$sys.log.p", "$sys.log.p/ui", "$sys.arch.p", "$sys.metrics.p", "$sys.backlog.log", "$sys.other", "game.move"].includes(subject)), ["$sys.arch.sync"]);
});

test("ownWorker marks a worker's re-raised error handled, and reports one that couldn't load", () => {
	class FakeErrorEvent extends Event {}
	const globals = globalThis as { "ErrorEvent"?: unknown };
	const saved = globals.ErrorEvent;

	globals.ErrorEvent = FakeErrorEvent;

	try {
		const worker = new EventTarget() as unknown as Worker;
		let failed = 0;
		const dispose = ownWorker(worker, () => { failed += 1; });
		const reraised = new FakeErrorEvent("error", { "cancelable": true });

		worker.dispatchEvent(reraised);
		assert.equal(reraised.defaultPrevented, true, "the owner won't report the worker's error again");
		worker.dispatchEvent(new Event("error"));
		assert.equal(failed, 1, "a load failure is reported");
		dispose();
		worker.dispatchEvent(new Event("error"));
		assert.equal(failed, 1);
	} finally {
		globals.ErrorEvent = saved;
	}
});

test("a relay marks a page that speaks a newer protocol than it knows — and only that", async () => {
	const { markOutdated, OBSERVABILITY_PROTOCOL } = await import("../src/tabs.ts");
	const tab = { "tab": "t", "url": "", "title": "", "visible": true, "focused": false };

	assert.equal(markOutdated({ ...tab, "protocol": OBSERVABILITY_PROTOCOL }).outdated, undefined);
	assert.equal(markOutdated(tab).outdated, undefined, "a page older than the protocol says nothing");
	assert.match(markOutdated({ ...tab, "protocol": OBSERVABILITY_PROTOCOL + 1 }).outdated ?? "", /restart it/u);
});

test("a page that goes says so, and the store ends it — until a reload brings it back under the same id", async (t) => {
	const { ArchitectureStore } = await import("../src/arch-store.ts");
	const { createArchReporter } = await import("../src/arch.ts");
	const globals = globalThis as { "window"?: unknown; "location"?: unknown; "addEventListener"?: unknown; "removeEventListener"?: unknown };
	const saved = { "window": globals.window, "location": globals.location, "addEventListener": globals.addEventListener, "removeEventListener": globals.removeEventListener };
	const listeners = new Map<string, () => void>();

	// A window realm (a page), with its pagehide.
	globals.window = { "parent": undefined };
	(globals.window as { "parent": unknown }).parent = globals.window;
	globals.location = { "href": "http://localhost/__virtual__/t/5173/" };
	globals.addEventListener = (type: string, handler: () => void) => { listeners.set(type, handler); };
	globals.removeEventListener = (type: string) => { listeners.delete(type); };

	try {
		const root = createHub({ "id": "root" });
		const page = createHub({ "id": "page" });
		const [up, down] = pipe();
		const store = new ArchitectureStore();
		const { collectArchReports } = await import("../src/arch.ts");

		collectArchReports(root, (report) => { store.apply(report); });
		await Promise.all([root.link(up).ready, page.link(down).ready]);

		const reporter = createArchReporter(page);

		t.after(() => { reporter.dispose(); });
		await until("the page, reporting", () => store.nodes.get("page")?.state === "alive");

		listeners.get("pagehide")!();

		const gone = await until("the page's last word", () => store.nodes.get("page")?.state === "terminated" ? store.nodes.get("page") : undefined);

		assert.equal(gone.state, "terminated", "its last word ended it");
		assert.equal(typeof gone.lastEndedAt, "number");

		const endedAt = gone.lastEndedAt;

		reporter.dispose();
		assert.equal(listeners.has("pagehide"), false, "disposing the reporter stops listening");

		// The reloaded page: same id, reporting again.
		store.apply({ "reporter": "page", "time": Date.now() });
		assert.equal(store.nodes.get("page")?.state, "alive");
		assert.equal(store.nodes.get("page")?.lastEndedAt, endedAt, "and when it last ended is kept (appEnded tells old workers from new)");
	} finally {
		Object.assign(globals, saved);
	}
});

test("a preview app's tab answer names its window — the id the editor's shell assigned its page", async () => {
	const { answerTabDiscovery } = await import("../src/index.ts");
	const { TAB_DISCOVER, TAB_HERE } = await import("../src/tabs.ts");
	const globals = globalThis as { "window"?: unknown; "location"?: unknown; "document"?: unknown };
	const saved = { "window": globals.window, "location": globals.location, "document": globals.document };
	const editor = { "location": { "pathname": "/" } };

	// A preview's top frame: its parent is the editor window.
	globals.window = { "parent": editor };
	globals.location = { "pathname": "/__virtual__/t1/5173/play.html", "href": "http://localhost/__virtual__/t1/5173/play.html" };
	globals.document = { "title": "netsim", "visibilityState": "visible", "hasFocus": () => true };

	try {
		const [up, down] = pipe();
		const shell = createHub({ "id": "shell" });
		const page = createHub({ "id": "page" });
		const answers: { "scope"?: string; "preview"?: boolean }[] = [];

		// The shell links the window's page as `preview:5173~2` — and its hello says so.
		await Promise.all([shell.link(up, { "peer": "preview:5173~2", "transit": false }).ready, page.link(down, { "uplink": true }).ready]);
		answerTabDiscovery(page, "app");
		shell.subscribe(TAB_HERE, (data) => { answers.push(data as { "scope"?: string; "preview"?: boolean }); });
		assert.ok(await shell.whenInterested(TAB_DISCOVER, 5000));
		assert.ok(await page.whenInterested(TAB_HERE, 5000));
		shell.publish(TAB_DISCOVER, { "query": "q" });
		await until("the page's answer", () => answers.length > 0);

		assert.equal(answers[0]?.preview, true);
		assert.equal(answers[0]?.scope, "preview:5173~2");
	} finally {
		Object.assign(globals, saved);
	}
});
