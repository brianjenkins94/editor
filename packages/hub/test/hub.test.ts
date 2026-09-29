import type { Transport, WebSocketLike } from "../src/index.ts";
import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createHub, createRpcClient, matches, serve, websocketTransport } from "../src/index.ts";

/** A connected pair of in-memory transports — delivery is async (a macrotask) to mirror postMessage, so tests
 *  `await flush()` to let interest control and messages settle across hops. */
function pipe(): [Transport, Transport] {
	let left: ((message: unknown) => void) | undefined;
	let right: ((message: unknown) => void) | undefined;

	return [
		{ "send": (message) => { setTimeout(() => right?.(message), 0); }, "listen": (onMessage) => {
			left = onMessage;

			return () => { left = undefined; };
		} },
		{ "send": (message) => { setTimeout(() => left?.(message), 0); }, "listen": (onMessage) => {
			right = onMessage;

			return () => { right = undefined; };
		} }
	];
}

/** Let queued deliveries (across several hops) drain. */
function flush(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, 10); });
}

test("subject matching", () => {
	assert.ok(matches("a.b", "a.b"));
	assert.ok(matches("a.*", "a.b"));
	assert.ok(matches("a.>", "a.b.c"));
	assert.ok(!matches("a.*", "a.b.c"));
	assert.ok(!matches("a.b", "a.c"));
	assert.ok(!matches("a.>", "a")); // `>` needs at least one more token
});

test("local publish reaches local subscribers", () => {
	const hub = createHub({ "id": "solo" });
	const seen: unknown[] = [];

	hub.subscribe("render.mutation", (data) => { seen.push(data); });
	hub.subscribe("render.>", (data) => { seen.push(["wild", data]); });
	hub.publish("render.mutation", 1);
	hub.publish("render.other", 2);

	assert.deepEqual(seen, [1, ["wild", 1], ["wild", 2]]);
});

test("linked hubs federate a subscribed subject in both directions", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	pod.link(b);

	const atPod: unknown[] = [];
	const atRoot: unknown[] = [];

	pod.subscribe("cmd.run", (data) => { atPod.push(data); });
	root.subscribe("peer.pod", (data) => { atRoot.push(data); });

	await flush(); // interest propagates across the link

	root.publish("cmd.run", "go");
	pod.publish("peer.pod", "ack");

	await flush();

	assert.deepEqual(atPod, ["go"]);
	assert.deepEqual(atRoot, ["ack"]);
});

test("local traffic stays local — an unsubscribed subject never crosses the link", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	pod.link(b);

	// The far side only wants `cmd.run`; it must never receive pod-local chatter.
	const atRoot: unknown[] = [];

	root.subscribe("cmd.run", (data) => { atRoot.push(data); });

	await flush();

	let crossed = false;

	root.subscribe("pod.internal", () => { crossed = true; }); // subscribed AFTER interest settled; still shouldn't arrive from a pre-existing publish
	pod.publish("pod.internal", "secret");

	await flush();

	assert.equal(crossed, false);
	assert.deepEqual(atRoot, []);
});

test("three-level tree: interest propagates up, messages route down", async () => {
	const [rootEnd, podUp] = pipe();
	const [podDown, workerEnd] = pipe();

	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const worker = createHub({ "id": "worker" });

	root.link(rootEnd);
	pod.link(podUp);
	pod.link(podDown);
	worker.link(workerEnd);

	const atWorker: unknown[] = [];

	worker.subscribe("ping", (data) => { atWorker.push(data); });

	await flush(); // worker → pod → root interest propagation

	root.publish("ping", 42); // published at the very top; must reach the leaf

	await flush();

	assert.deepEqual(atWorker, [42]);
});

test("interest survives a late link on a LOSSY transport (hello handshake)", async () => {
	// A window-like transport: a message is DROPPED if the peer isn't listening at send time (no queue, unlike
	// a MessagePort). The hub's `hello` handshake must recover from an interest advertisement lost to the race.
	let left: ((message: unknown) => void) | undefined;
	let right: ((message: unknown) => void) | undefined;
	const a: Transport = { "send": (message) => {
		if (right !== undefined) {
			const to = right;

			setTimeout(to, 0, message);
		}
	}, "listen": (onMessage) => {
		left = onMessage;

		return () => { left = undefined; };
	} };
	const b: Transport = { "send": (message) => {
		if (left !== undefined) {
			const to = left;

			setTimeout(to, 0, message);
		}
	}, "listen": (onMessage) => {
		right = onMessage;

		return () => { right = undefined; };
	} };

	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	const atRoot: unknown[] = [];

	root.subscribe("cmd", (data) => { atRoot.push(data); });

	root.link(a); // root advertises "cmd" — but pod isn't listening yet, so it's DROPPED
	await flush();

	pod.link(b); // pod's hello reaches root (listening) → root re-advertises → pod learns "cmd"
	await flush();

	pod.publish("cmd", "recovered");
	await flush();

	assert.deepEqual(atRoot, ["recovered"]);
	// root's own hello was dropped, but it answers pod's — so BOTH ends know who is across the link
	assert.equal(root.inspect().links[0]?.peerId, "pod");
	assert.equal(pod.inspect().links[0]?.peerId, "root");
});

test("websocketTransport federates over a JSON-framed, EventTarget-shaped socket", async () => {
	// A connected pair of WebSocket-shaped endpoints: `send` frames to the peer's `message` listeners, delivered
	// async (like a real socket). Verifies JSON framing round-trips and that a Buffer-ish `data` is coerced.
	function socketPair(): [WebSocketLike, WebSocketLike] {
		const listeners: [Set<(event: { "data": unknown }) => void>, Set<(event: { "data": unknown }) => void>] = [new Set(), new Set()];

		const make = (self: 0 | 1): WebSocketLike => ({
			"readyState": 1,
			"send": (data) => {
				const peer = listeners[self === 0 ? 1 : 0]; const wire = self === 0 ? Buffer.from(data) : data;

				setTimeout(() => { for (const fn of peer) { fn({ "data": wire }); } }, 0);
			},
			"addEventListener": (_type, handler) => { listeners[self].add(handler); },
			"removeEventListener": (_type, handler) => { listeners[self].delete(handler); }
		});

		return [make(0), make(1)];
	}

	const [clientSocket, serverSocket] = socketPair();
	const page = createHub({ "id": "page" });
	const debugMcp = createHub({ "id": "debug-mcp" });

	page.link(websocketTransport(clientSocket));
	debugMcp.link(websocketTransport(serverSocket));

	const collected: unknown[] = [];

	debugMcp.subscribe("$sys.log.>", (data) => { collected.push(data); });

	await flush(); // interest crosses the socket

	page.publish("$sys.log.worker", { "message": "step", "durationMs": 3 });
	page.publish("app.local", "should-not-cross"); // debug-mcp never subscribed to this

	await flush();

	assert.deepEqual(collected, [{ "message": "step", "durationMs": 3 }]);
});

test("request/reply across a link: relay calls a tool the far hub serves", async () => {
	const [a, b] = pipe();
	const relay = createHub({ "id": "relay" });
	const tab = createHub({ "id": "tab" });

	relay.link(a);
	tab.link(b);

	// The "tab" hosts a tool; the "relay" (what an MCP server would be) calls it and awaits the answer.
	serve(tab, "add", (args) => {
		const { x, y } = args as { "x": number; "y": number };

		return x + y;
	});
	serve(tab, "boom", () => { throw new Error("nope"); });

	const rpc = createRpcClient(relay);

	await flush(); // reply-channel + serve interest propagate across the link before the first call

	assert.equal(await rpc.request("add", { "x": 2, "y": 3 }), 5);

	await assert.rejects(rpc.request("boom"), /nope/); // served errors surface as a rejection
});

test("request times out when nothing serves the tool", async () => {
	const relay = createHub({ "id": "solo-relay" });
	const rpc = createRpcClient(relay);

	await assert.rejects(rpc.request("missing", undefined, { "timeoutMs": 30 }), /timed out/);
});

test("unlink stops federation and withdraws interest", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	const unlink = pod.link(b);

	const atPod: unknown[] = [];

	pod.subscribe("cmd.run", (data) => { atPod.push(data); });

	await flush();
	root.publish("cmd.run", "before");
	await flush();

	unlink();
	root.publish("cmd.run", "after");
	await flush();

	assert.deepEqual(atPod, ["before"]);
});

test("inspect reports subscriptions, links, peers and interest", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	pod.link(b);
	pod.subscribe("cmd.>", () => undefined);
	await flush();

	const atRoot = root.inspect();
	const atPod = pod.inspect();

	assert.equal(atRoot.id, "root");
	assert.deepEqual(atRoot.subscriptions, []);
	assert.equal(atRoot.links.length, 1);
	assert.equal(atRoot.links[0]?.id, "link-1");
	assert.equal(atRoot.links[0]?.peerId, "pod");
	assert.deepEqual(atRoot.links[0]?.remoteInterest, ["cmd.>"]);
	assert.deepEqual(atPod.subscriptions, ["cmd.>"]);
	assert.equal(atPod.links[0]?.peerId, "root");
	assert.deepEqual(atPod.links[0]?.advertised, ["cmd.>"]);
	// the snapshot is plain data
	assert.deepEqual(JSON.parse(JSON.stringify(atRoot)), atRoot);
});

test("a tap sees publish, send, receive and deliver — with the peer of each link", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const rootEvents: string[] = [];
	const podEvents: string[] = [];

	root.link(a);
	pod.link(b);
	pod.subscribe("cmd.run", () => undefined);
	await flush();

	root.tap((event) => {
		if (event.type === "publish") {
			rootEvents.push("publish " + event.envelope.subject);
		} else if ((event.type === "send" || event.type === "receive") && "subject" in event.frame) {
			rootEvents.push(`${event.type} ${event.frame.subject} ${event.link.peerId}`);
		}
	});
	pod.tap((event) => {
		if (event.type === "deliver") {
			podEvents.push(`deliver ${event.envelope.subject} from ${event.envelope.from} via ${event.link?.peerId} to ${event.handlers}`);
		}
	});
	pod.tap(() => { throw new Error("a broken tap"); }); // must not break routing

	root.publish("cmd.run", "go");
	root.publish("cmd.other", "stays local");
	await flush();

	assert.deepEqual(rootEvents, ["publish cmd.run", "send cmd.run pod", "publish cmd.other"]);
	assert.deepEqual(podEvents, ["deliver cmd.run from root via root to 1"]);
});

test("a tap is told when the topology changes, and can be disposed", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	let changes = 0;
	const dispose = root.tap((event) => {
		if (event.type === "topology") {
			changes += 1;
		}
	});

	const unlink = root.link(a); // link
	pod.link(b);
	await flush(); // peer learned

	const afterLink = changes;

	assert.ok(afterLink >= 2);
	root.subscribe("x", () => undefined); // subscription
	assert.equal(changes, afterLink + 1);
	unlink(); // unlink
	assert.equal(changes, afterLink + 2);
	dispose();
	root.subscribe("y", () => undefined);
	assert.equal(changes, afterLink + 2);
});
