import type { Transport, WebSocketLike } from "../src/index.ts";
import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createHub, createRpcClient, frameOf, matches, pipe, serve, websocketTransport } from "../src/index.ts";

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
	const [a, b] = pipe({ "lossy": true });

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

test("aborting a request rejects it with the signal's reason and aborts the responder's handler, which never replies", async () => {
	const [a, b] = pipe();
	const caller = createHub({ "id": "caller" });
	const server = createHub({ "id": "server" });

	caller.link(a);
	server.link(b);

	let handlerSignal: AbortSignal | undefined;
	let replies = 0;

	// A slow tool that stops when told to.
	serve(server, "slow", (_args, { signal }) => {
		handlerSignal = signal;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { resolve("done"); }, 1000);

			signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("stopped")); });
		});
	});
	caller.tap((event) => {
		if (event.type === "receive" && event.frame.subject?.startsWith("$rpc.reply.") === true) {
			replies += 1;
		}
	});

	const rpc = createRpcClient(caller);

	await flush();

	const controller = new AbortController();
	const call = rpc.request("slow", undefined, { "signal": controller.signal });

	await flush(); // the call reaches the server
	controller.abort(new Error("superseded"));
	await assert.rejects(call, /superseded/u);
	await flush(); // the cancel reaches the server

	assert.equal(handlerSignal?.aborted, true);
	assert.equal(replies, 0); // a cancelled call sends no reply
});

test("an already-aborted signal rejects before anything is sent, and aborting while waiting for a responder stops the wait", async () => {
	const caller = createHub({ "id": "early-caller" });
	const rpc = createRpcClient(caller);
	let published = 0;

	caller.tap((event) => {
		if (event.type === "publish" && event.envelope.subject.startsWith("$rpc.call.")) {
			published += 1;
		}
	});

	await assert.rejects(rpc.request("tool", undefined, { "signal": AbortSignal.abort(new Error("already")) }), /already/u);
	assert.equal(published, 0);

	const controller = new AbortController();
	const started = Date.now();
	const waiting = rpc.request("tool", undefined, { "waitForResponderMs": 5000, "signal": controller.signal });

	setTimeout(() => { controller.abort(new Error("gave up")); }, 20);
	await assert.rejects(waiting, /gave up/u);
	assert.ok(Date.now() - started < 1000); // not the whole 5s wait
});

test("timeoutMs: Infinity never times out", async () => {
	const [a, b] = pipe();
	const caller = createHub({ "id": "patient-caller" });
	const server = createHub({ "id": "late-server" });

	caller.link(a);
	server.link(b);
	serve(server, "late", () => new Promise((resolve) => { setTimeout(() => { resolve("eventually"); }, 50); }));

	const rpc = createRpcClient(caller);

	await flush();
	assert.equal(await rpc.request("late", undefined, { "timeoutMs": Infinity }), "eventually");
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

test("waitForResponderMs: a call waits for a responder still linking in, and fails fast when none comes", async () => {
	const caller = createHub({ "id": "caller" });
	const rpc = createRpcClient(caller);

	// No responder anywhere: rejects after the wait, not the (much longer) call timeout.
	const started = Date.now();

	await assert.rejects(rpc.request("tool", {}, { "timeoutMs": 60000, "waitForResponderMs": 50 }), /no responder/u);
	assert.ok(Date.now() - started < 1000);

	// A responder that links in during the wait is reached.
	const server = createHub({ "id": "server" });

	serve(server, "tool", (args) => ({ "echo": args }));
	const pending = rpc.request("tool", 7, { "timeoutMs": 1000, "waitForResponderMs": 1000 });
	const [a, b] = pipe();

	setTimeout(() => {
		caller.link(a);
		server.link(b);
	}, 30);
	assert.deepEqual(await pending, { "echo": 7 });
	assert.ok(caller.interested("$rpc.call.tool"));
});

test("non-transit links: a hub above several trees reaches each, but never joins them", async () => {
	const center = createHub({ "id": "center" });
	const tabA = createHub({ "id": "tab-a" });
	const tabB = createHub({ "id": "tab-b" });
	const [a1, a2] = pipe();
	const [b1, b2] = pipe();

	center.link(a1, { "transit": false });
	tabA.link(a2);
	center.link(b1, { "transit": false });
	tabB.link(b2);

	const inB: unknown[] = [];
	const inCenter: unknown[] = [];

	serve(tabB, "tool", () => "from tab B");
	tabB.subscribe("event", (data) => { inB.push(data); });
	center.subscribe("event", (data) => { inCenter.push(data); });
	await flush();

	// Tab A can't reach tab B — not its tool (a request in one tab isn't answered by another), not its events.
	assert.ok(!tabA.interested("$rpc.call.tool"));
	await assert.rejects(createRpcClient(tabA).request("tool", {}, { "waitForResponderMs": 50 }), /no responder/u);
	tabA.publish("event", 1);
	await flush();
	assert.deepEqual(inB, []);
	assert.deepEqual(inCenter, [1]); // …but the center still hears it

	// The center reaches tab B.
	assert.equal(await createRpcClient(center).request("tool", {}, { "timeoutMs": 1000 }), "from tab B");
});

/** An edge hub with one untrusted peer linked under `options` (and the peer's hub). */
async function edge(options: Parameters<ReturnType<typeof createHub>["link"]>[1]) {
	const hub = createHub({ "id": "edge" });
	const peer = createHub({ "id": "claims-to-be-someone" });
	const [a, b] = pipe();

	hub.link(a, options);
	peer.link(b);
	await flush();

	return { "hub": hub, "peer": peer };
}

test("an assigned peer id overrides the peer's hello and stamps `from` on everything it sends", async () => {
	const { hub, peer } = await edge({ "peer": "seat-1" });
	const seen: (string | undefined)[] = [];

	hub.subscribe("game.cmd", (_data, envelope) => { seen.push(envelope.from); });
	await flush();
	peer.publish("game.cmd", 1);
	await flush();
	assert.deepEqual(seen, ["seat-1"]);
	assert.equal(hub.inspect().links[0].peerId, "seat-1", "the hello's claim didn't replace it");
});

test("a stamped `from` stays authenticated across trusted hops", async () => {
	const { hub, peer } = await edge({ "peer": "seat-1" });
	const inner = createHub({ "id": "inner" });
	const [a, b] = pipe();
	const seen: (string | undefined)[] = [];

	hub.link(a);
	inner.link(b);
	inner.subscribe("game.cmd", (_data, envelope) => { seen.push(envelope.from); });
	await flush();
	peer.publish("game.cmd", 1);
	await flush();
	assert.deepEqual(seen, ["seat-1"]);
});

test("handlers learn the link a message arrived on; a local publish has none", async () => {
	const { hub, peer } = await edge({ "peer": "seat-1" });
	const origins: unknown[] = [];

	hub.subscribe("x", (_data, _envelope, origin) => { origins.push(origin.link); });
	await flush();
	peer.publish("x");
	hub.publish("x");
	await flush();
	assert.deepEqual(origins, [undefined, { "id": "link-1", "peerId": "seat-1" }]);
});

test("publish permissions drop what a peer may not send, and a tap sees the deny", async () => {
	const { hub, peer } = await edge({ "peer": "seat-1", "permissions": { "publish": ["game.cmd"] } });
	const received: unknown[] = [];
	const denied: unknown[] = [];

	hub.subscribe("game.>", (data) => { received.push(data); });
	hub.tap((event) => {
		if (event.type === "deny") {
			denied.push([event.direction, event.envelope.subject, event.link.peerId]);
		}
	});
	await flush();
	peer.publish("game.cmd", "ok");
	peer.publish("game.admin", "nope");
	await flush();
	assert.deepEqual(received, ["ok"]);
	assert.deepEqual(denied, [["publish", "game.admin", "seat-1"]]);
});

test("subscribe permissions confine what a peer receives, even under a broad wildcard", async () => {
	const { hub, peer } = await edge({ "peer": "seat-1", "permissions": { "subscribe": ["game.state.1"] } });
	const received: unknown[] = [];
	const denied: string[] = [];

	hub.tap((event) => {
		if (event.type === "deny") {
			denied.push(event.envelope.subject);
		}
	});
	peer.subscribe("game.state.*", (data, envelope) => { received.push([envelope.subject, data]); });
	await flush();
	hub.publish("game.state.0", "team 0's view");
	hub.publish("game.state.1", "team 1's view");
	await flush();
	assert.deepEqual(received, [["game.state.1", "team 1's view"]]);
	assert.deepEqual(denied, ["game.state.0"]);
});

test("permissions also stop a peer snooping another caller's RPC replies", async () => {
	const { hub, peer } = await edge({ "peer": "rogue", "permissions": { "subscribe": ["$rpc.reply.rogue"] } });
	const victim = createHub({ "id": "victim" });
	const [a, b] = pipe();
	const snooped: unknown[] = [];

	hub.link(a, { "peer": "victim" });
	victim.link(b);
	serve(hub, "secret", () => "for the victim only");
	peer.subscribe("$rpc.reply.victim", (data) => { snooped.push(data); });
	await flush();
	assert.equal(await createRpcClient(victim).request("secret", undefined, { "timeoutMs": 1000 }), "for the victim only");
	await flush();
	assert.deepEqual(snooped, []);
});

test("permit() changes a link's permissions later (e.g. once a player is seated)", async () => {
	const { hub, peer } = await edge({ "peer": "seat-1", "permissions": { "subscribe": [] } });
	const received: unknown[] = [];

	peer.subscribe("game.state.1", (data) => { received.push(data); });
	await flush();
	hub.publish("game.state.1", "before");
	assert.equal(hub.permit("seat-1", { "subscribe": ["game.state.1"] }), true);
	assert.deepEqual(hub.inspect().links[0].permissions, { "subscribe": ["game.state.1"] });
	hub.publish("game.state.1", "after");
	await flush();
	assert.deepEqual(received, ["after"]);
	assert.equal(hub.permit("nobody", undefined), false);
	assert.equal(hub.permit("seat-1", undefined), true);
	assert.equal(hub.inspect().links[0].permissions, undefined, "lifted");
});

test("serve handlers see the caller's authenticated `from` and the link the call came in on", async () => {
	const { hub, peer } = await edge({ "peer": "seat-7" });
	let context: unknown;

	serve(hub, "whoami", (_args, { from, link }) => {
		context = { "from": from, "link": link };

		return from;
	});
	await flush();
	assert.equal(await createRpcClient(peer).request("whoami", undefined, { "timeoutMs": 1000 }), "seat-7");
	assert.deepEqual(context, { "from": "seat-7", "link": { "id": "link-1", "peerId": "seat-7" } });
});

test("a link is ready once the peer's hello has arrived — and with it, the peer's interest", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	pod.subscribe("x", () => undefined);

	const link = root.link(a);

	assert.equal(root.interested("x"), false, "nothing known yet");
	pod.link(b);
	assert.equal(await link.ready, true);
	assert.equal(root.interested("x"), true, "the pod's interest is known the moment the link is ready");
});

test("ready means the interest is known even when the peer's first hello was lost (it re-sends interest before answering)", async () => {
	const [a, b] = pipe({ "lossy": true });
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	pod.subscribe("x", () => undefined);
	// The pod links first: its interest and hello are dropped (root isn't listening yet).
	pod.link(b);
	await flush();

	// Root links: its hello reaches the pod, which re-sends its interest and answers. Ready must not come first.
	const link = root.link(a);

	assert.equal(await link.ready, true);
	assert.equal(root.interested("x"), true);
});

test("a link that goes before the peer ever answers isn't ready", async () => {
	const [a] = pipe();
	const root = createHub({ "id": "root" });
	const link = root.link(a);

	link();
	assert.equal(await link.ready, false);
});

test("publishWhenInterested holds a one-off message until someone wants it — or gives up", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const seen: unknown[] = [];

	pod.subscribe("seat", (data) => { seen.push(data); });
	root.link(a);
	pod.link(b);

	// Published at once, it would go nowhere: root doesn't know the pod wants it yet.
	const sent = root.publishWhenInterested("seat", "token", 1000);

	assert.equal(await sent, true);
	await flush();
	assert.deepEqual(seen, ["token"]);
	assert.equal(await root.publishWhenInterested("nobody", 1, 30), false);
});

test("pipe: held until the other end listens (MessagePort-like), or dropped (window-like, `lossy`)", async () => {
	const [held, heldOther] = pipe();
	const [dropped, droppedOther] = pipe({ "lossy": true });
	const seen: unknown[] = [];

	held.send("early");
	dropped.send("early");
	await flush();
	heldOther.listen((message) => { seen.push(["held", message]); });
	droppedOther.listen((message) => { seen.push(["lossy", message]); });
	await flush();
	dropped.send("late");
	await flush();

	assert.deepEqual(seen, [["held", "early"], ["lossy", "late"]]);
});

test("pipe's schedule decides how each message travels — fault injection by subject, control frames untouched", async () => {
	const decided: string[] = [];
	// Drop game traffic, duplicate chat, deliver everything else (control frames included) as is.
	const [a, b] = pipe({ "schedule": (deliver, message) => {
		const frame = frameOf(message);
		const subject = frame !== undefined && "hub" in frame ? "control:" + frame.hub : frame?.subject;

		decided.push(String(subject));

		if (subject === "game.state") {
			return;
		}

		setTimeout(deliver, 0);

		if (subject === "chat") {
			setTimeout(deliver, 0);
		}
	} });
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const seen: unknown[] = [];

	pod.subscribe("game.state", (data) => { seen.push(["state", data]); });
	pod.subscribe("chat", (data) => { seen.push(["chat", data]); });
	const links = [root.link(a), pod.link(b)];

	assert.deepEqual(await Promise.all(links.map(async (link) => link.ready)), [true, true]);
	await flush();
	root.publish("game.state", 1);
	root.publish("chat", "hi");
	await flush();

	assert.deepEqual(seen, [["chat", "hi"], ["chat", "hi"]]);
	assert.ok(decided.includes("control:hello") && decided.includes("control:sub"), "control frames were seen, and delivered");
	assert.equal(frameOf("not a hub message"), undefined);
	assert.equal(frameOf({ "subject": "x" }), undefined, "a bare envelope-shaped object isn't a hub frame");
});

test("a link's handle carries its id — the one handlers' origin.link and inspect() use", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const arrived: (string | undefined)[] = [];

	root.subscribe("hello.root", (_data, _envelope, origin) => { arrived.push(origin.link?.id); });

	const link = root.link(a);

	pod.link(b);
	await link.ready;
	pod.publish("hello.root");
	await flush();

	assert.deepEqual(arrived, [link.id]);
	assert.deepEqual(root.inspect().links.map((entry) => entry.id), [link.id]);
});
