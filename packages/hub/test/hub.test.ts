import type { Transport, WebSocketLike } from "../src/index.ts";
import * as assert from "node:assert/strict";

import { test } from "node:test";
import { channelTransport, createHub, createRpcClient, dataChannelTransport, frameOf, mapFrame, matches, pipe, serve, websocketTransport } from "../src/index.ts";

/** Let queued deliveries (across several hops) drain. */
/** Let what's in flight land. A pipe delivers each hop on a timer of its own, so this waits timer turns, not wall time:
 *  a loop that stalls (a busy CI runner) fires every due timer in one batch, and a fixed sleep would resolve in that batch
 *  — before the next hop's timer even exists. Each turn queues behind every hop already scheduled, so each lets the
 *  traffic go at least one hop further; twenty cover the longest chain here (hellos, interest and a message, three deep). */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) {
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	}
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
		} else if ((event.type === "send" || event.type === "receive") && !("hub" in event.frame)) {
			// (Messages only: the handshake's interest frames may still be settling on a slow machine.)
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
	// The edge is the peer's uplink: the hub that decides who it is.
	peer.link(b, { "uplink": true });
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
	// The peer is asked only for what it may send (game.cmd, not all of game.>); one that sends more anyway is denied.
	const hub = createHub({ "id": "edge" });
	const [a, b] = pipe();
	const received: unknown[] = [];
	const denied: unknown[] = [];
	const asked: string[] = [];

	hub.subscribe("game.>", (data) => { received.push(data); });
	hub.tap((event) => {
		if (event.type === "deny") {
			denied.push([event.direction, event.envelope.subject, event.link.peerId]);
		}
	});
	hub.link(a, { "peer": "seat-1", "permissions": { "publish": ["game.cmd"] } });
	b.listen((message) => {
		const frame = frameOf(message);

		if (frame !== undefined && "hub" in frame && frame.hub === "sub") {
			asked.push(frame.subject!);
		}
	});
	await flush();
	b.send({ "\0hub": { "subject": "game.cmd", "data": "ok" } });
	b.send({ "\0hub": { "subject": "game.admin", "data": "nope" } });
	await flush();
	assert.deepEqual(asked, ["game.cmd"]);
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

test("a peer learns the id its edge assigned it — and its RPC calls come back through an edge that permits only that", async () => {
	// The peer calls itself "worker"; the edge knows it as "seat-3", stamps that, and lets through only its replies.
	const { hub, peer } = await edge({ "peer": "seat-3", "permissions": { "publish": ["$rpc.call.>"], "subscribe": ["$rpc.reply.seat-3"] } });

	serve(hub, "whoami", (_args, { from }) => from);
	await flush();
	assert.deepEqual(peer.knownAs(), ["seat-3"], "told in the edge's hello");
	assert.deepEqual(hub.knownAs(), [], "and the edge isn't renamed by anything");
	assert.equal(await createRpcClient(peer).request("whoami", undefined, { "timeoutMs": 1000 }), "seat-3", "the reply reached it under the assigned id");
});

test("only a hub's uplink can name it: not a child, nor any other peer, whatever order they linked in", async () => {
	const [a, b] = pipe();
	const parent = createHub({ "id": "parent" });

	parent.link(a, { "peer": "child" });
	// A hostile child, speaking the wire directly: its hello claims the parent is someone else.
	b.listen(() => undefined);
	b.send({ "\u0000hub": { "hub": "hello", "id": "child", "you": "victim" } });
	await flush();
	assert.deepEqual(parent.knownAs(), [], "a child it named");

	// A child it didn't name, linked BEFORE its uplink — then the uplink, which does name it.
	const page = createHub({ "id": "page" });
	const [c, d] = pipe();
	const [e, f] = pipe();

	page.link(c);
	d.listen(() => undefined);
	d.send({ "\u0000hub": { "hub": "hello", "id": "frame", "you": "whatever-evil" } });
	page.link(e, { "uplink": true });
	f.listen(() => undefined);
	f.send({ "\u0000hub": { "hub": "hello", "id": "shell", "you": "preview:5173" } });
	await flush();
	assert.deepEqual(page.knownAs(), ["preview:5173"], "only the uplink's word");
});

test("a hub named by its uplink still calls down its tree and gets its replies — a reply goes to the caller's `from`", async () => {
	// The editor's shape: shell ─(names it preview:5173)─ page ─ referee ─(names it client-0, lets it answer only
	// the page)─ client. The page's call to the client must come back, though the page is preview:5173 to the shell.
	const shell = createHub({ "id": "shell" });
	const page = createHub({ "id": "page" });
	const referee = createHub({ "id": "referee" });
	const client = createHub({ "id": "client" });
	const [s1, s2] = pipe();
	const [r1, r2] = pipe();
	const [c1, c2] = pipe();

	shell.link(s1, { "peer": "preview:5173", "transit": false });
	page.link(s2, { "uplink": true });
	page.link(r1);
	referee.link(r2);
	referee.link(c1, { "peer": "client-0", "permissions": { "publish": ["$rpc.reply.page"], "subscribe": ["$rpc.call.inspect"] } });
	client.link(c2, { "uplink": true });
	serve(client, "inspect", (_args, { from }) => ({ "from": from }));
	await flush();
	assert.deepEqual(page.knownAs(), ["preview:5173"]);
	assert.deepEqual(await createRpcClient(page).request("inspect", undefined, { "timeoutMs": 1000 }), { "from": "page" });
});

test("interested() counts a link only if its permissions would let the message through", async () => {
	const [a, b] = pipe();
	const hub = createHub({ "id": "hub" });
	const peer = createHub({ "id": "peer" });

	hub.link(a, { "peer": "peer", "permissions": { "subscribe": ["allowed"] } });
	peer.link(b);
	peer.subscribe("allowed", () => undefined);
	peer.subscribe("denied", () => undefined);
	await flush();
	assert.equal(hub.interested("allowed"), true);
	assert.equal(hub.interested("denied"), false, "interested, but the link would refuse it");
	assert.equal(await hub.whenInterested("denied", 50), false);
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

test("whenInterested waits until someone wants a subject — or gives up", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const seen: unknown[] = [];

	pod.subscribe("seat", (data) => { seen.push(data); });
	root.link(a);
	pod.link(b);

	// Published at once, it would go nowhere: root doesn't know the pod wants it yet.
	assert.equal(root.interested("seat"), false);
	assert.equal(await root.whenInterested("seat", 1000), true);
	root.publish("seat", "token");
	await flush();
	assert.deepEqual(seen, ["token"]);
	assert.equal(await root.whenInterested("nobody", 30), false);
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

test("mapFrame rewrites the frame a message carries, so a transport can rename what crosses it", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const seen: [string, unknown][] = [];
	// root's end renames the pod's `status.*` to `pod.status.*`; everything else crosses as is.
	const renaming = { "send": a.send, "listen": (onMessage: (message: unknown) => void) => a.listen((message) => {
		onMessage(mapFrame(message, (frame) => (!("hub" in frame) && frame.subject.startsWith("status.") ? { ...frame, "subject": "pod." + frame.subject } : frame)));
	}) };

	root.subscribe(">", (data, envelope) => { seen.push([envelope.subject, data]); });
	await Promise.all([root.link(renaming).ready, pod.link(b).ready]);
	await flush();
	pod.publish("status.up", 1);
	pod.publish("other", 2);
	await flush();

	assert.deepEqual(seen, [["pod.status.up", 1], ["other", 2]]);
	assert.equal(mapFrame("not a hub message", () => { throw new Error("not called"); }), "not a hub message");
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

test("a disposed rpc client stops listening for replies and fails what it was still waiting on", async () => {
	const [up, down] = pipe();
	const server = createHub({ "id": "server" });
	const caller = createHub({ "id": "caller" });

	await Promise.all([server.link(up).ready, caller.link(down).ready]);
	serve(server, "slow", () => new Promise(() => { /* never answers */ }));

	const rpc = createRpcClient(caller);

	await caller.whenInterested("$rpc.call.slow", 1000);

	const waiting = rpc.request("slow", {}, { "timeoutMs": 60_000 });

	await flush();
	assert.equal(server.interested("$rpc.reply.caller"), true);
	rpc.dispose();
	await assert.rejects(waiting, /disposed/u);
	await flush();
	assert.equal(server.interested("$rpc.reply.caller"), false, "its reply subject is no longer advertised");
	assert.equal(caller.interested("$rpc.reply.caller"), false);
});

test("channelTransport: two hubs meet over a BroadcastChannel by name, and close lets it go", async () => {
	const name = "hub-test-" + crypto.randomUUID();
	const [left, right] = [channelTransport(name), channelTransport(name)];
	const a = createHub({ "id": "a" });
	const b = createHub({ "id": "b" });
	const seen: unknown[] = [];

	b.subscribe("hi", (data) => { seen.push(data); });
	await Promise.all([a.link(left).ready, b.link(right).ready]);
	a.publish("hi", 1);
	await new Promise((resolve) => { setTimeout(resolve, 50); });
	assert.deepEqual(seen, [1]);
	left.close();
	right.close();
});

test("a confined link is told only of interest it could serve — so nobody past it takes it for a listener", async () => {
	// page ─ referee ─ client: the client serves a debug call, but its link lets the referee send it only the game.
	const [pageEnd, refereeUp] = pipe();
	const [refereeDown, clientEnd] = pipe();
	const page = createHub({ "id": "page" });
	const referee = createHub({ "id": "referee" });
	const client = createHub({ "id": "client-0" });

	serve(client, "debug.client-0.inspect", () => "reached");
	client.subscribe("game.state", () => undefined);
	await Promise.all([page.link(pageEnd).ready, referee.link(refereeUp).ready, referee.link(refereeDown, { "peer": "client-0" }).ready, client.link(clientEnd, { "uplink": true, "transit": false, "permissions": { "publish": ["game.*"], "subscribe": [] } }).ready]);
	await flush();

	assert.equal(referee.interested("game.state"), true, "what the client may be sent, it asks for");
	assert.equal(referee.interested("$rpc.call.debug.client-0.inspect"), false, "what it may not, it never mentions");
	assert.equal(page.interested("$rpc.call.debug.client-0.inspect"), false, "so the page doesn't wait on an answer that can't come");

	// Permitted later (the client learns it may be debugged), its interest follows.
	client.permit("referee", { "publish": ["game.*", "$rpc.call.debug.>"], "subscribe": ["$rpc.reply.>"] });
	// (Two hops to travel — client → referee → page: wait for it rather than a fixed while.)
	assert.equal(await page.whenInterested("$rpc.call.debug.client-0.inspect", 2000), true);
	assert.equal(await createRpcClient(page).request("debug.client-0.inspect", undefined, { "timeoutMs": 1000 }), "reached");
});

test("interest passes on only as far as each link may receive it", async () => {
	// root ─ hub ─ peer, the peer allowed only $sys.log.p: a root subscribing to all of $sys.log still gets it asked
	// for (the patterns overlap), but a subject the peer may not receive isn't asked of it.
	const [rootEnd, up] = pipe();
	const [down, peerEnd] = pipe();
	const root = createHub({ "id": "root" });
	const hub = createHub({ "id": "hub" });
	const peer = createHub({ "id": "p" });

	root.subscribe("$sys.log.>", () => undefined);
	root.subscribe("game.secret", () => undefined);
	await Promise.all([root.link(rootEnd).ready, hub.link(up).ready, hub.link(down, { "peer": "p", "permissions": { "publish": ["$sys.log.p"] } }).ready, peer.link(peerEnd).ready]);
	await flush();

	assert.equal(peer.interested("$sys.log.p"), true);
	assert.equal(peer.interested("game.secret"), false);
});

// ── Hardening (the NATS audit) ──────────────────────────────────────────────────────────────────────────────────────

/** Every fault a hub's tap reports. */
function faults(hub: ReturnType<typeof createHub>): { "kind": string; "detail": string }[] {
	const seen: { "kind": string; "detail": string }[] = [];

	hub.tap((event) => {
		if (event.type === "fault") {
			seen.push({ "kind": event.kind, "detail": event.detail });
		}
	});

	return seen;
}

/** A link's interest. */
function interestOf(hub: ReturnType<typeof createHub>, index = 0): string[] {
	return hub.inspect().links[index]?.remoteInterest ?? [];
}

test("a throwing handler doesn't stop the other handlers, or the message going on across links", async () => {
	const errors: unknown[] = [];
	const [a, b] = pipe();
	const root = createHub({ "id": "root", "onError": (error) => { errors.push(error); } });
	const pod = createHub({ "id": "pod" });
	const seen: string[] = [];
	const reported = faults(root);

	root.subscribe("x", () => { throw new Error("handler bug"); });
	root.subscribe("x", () => { seen.push("root"); });
	pod.subscribe("x", () => { seen.push("pod"); });
	await Promise.all([root.link(a).ready, pod.link(b).ready]);

	assert.doesNotThrow(() => { root.publish("x"); });
	await flush();

	assert.deepEqual(seen, ["root", "pod"]);
	assert.equal((errors[0] as Error).message, "handler bug");
	assert.equal(reported[0]?.kind, "handler");
});

test("a frame the transport can't send is dropped — the publisher isn't thrown at, and the link carries on", async () => {
	const [a, b] = pipe();
	const fussy: Transport = { ...a, "send": (message) => {
		if ((frameOf(message) as { "data"?: unknown } | undefined)?.data === "unclonable") {
			throw new Error("DataCloneError");
		}

		a.send(message);
	} };
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const seen: unknown[] = [];
	const reported = faults(root);

	pod.subscribe("x", (data) => { seen.push(data); });
	await Promise.all([root.link(fussy).ready, pod.link(b).ready]);

	assert.doesNotThrow(() => { root.publish("x", "unclonable"); });
	root.publish("x", "fine");
	await flush();

	assert.deepEqual(seen, ["fine"]);
	assert.equal(reported[0]?.kind, "send");
	assert.equal(root.inspect().links.length, 1);
});

test("a link whose transport closes is unlinked at both ends", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const reported = faults(root);

	pod.subscribe("x", () => undefined);
	await Promise.all([root.link(a).ready, pod.link(b).ready]);
	assert.equal(root.interested("x"), true);

	a.close();
	await flush();

	assert.equal(root.inspect().links.length, 0);
	assert.equal(pod.inspect().links.length, 0);
	assert.equal(root.interested("x"), false, "a closed link's interest goes with it");
	assert.equal(reported[0]?.kind, "closed");
});

test("heartbeat: a link that goes silent is unlinked; a live one stays", async () => {
	let cut = false;
	const [a, b] = pipe({ "schedule": (deliver) => { setTimeout(() => { if (!cut) { deliver(); } }, 0); } });
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const reported = faults(root);

	await Promise.all([root.link(a, { "heartbeatMs": 20 }).ready, pod.link(b).ready]);
	await new Promise((resolve) => { setTimeout(resolve, 120); });
	assert.equal(root.inspect().links.length, 1, "pings answered: still linked");

	cut = true; // the peer vanishes without a word (a tab killed, a network gone)
	await new Promise((resolve) => { setTimeout(resolve, 150); });

	assert.equal(root.inspect().links.length, 0);
	assert.equal(reported.at(-1)?.kind, "stale");
});

test("a peer that restarts on the same transport leaves no ghost interest behind", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const before = createHub({ "id": "frame" });

	before.subscribe("old", () => undefined);
	const unlinkBefore = before.link(b);

	await Promise.all([root.link(a).ready, unlinkBefore.ready]);
	assert.equal(root.interested("old"), true);

	// The frame reloads: its hub is gone without a word, and a new one links the same transport.
	unlinkBefore();
	const after = createHub({ "id": "frame" });

	after.subscribe("new", () => undefined);
	await after.link(b).ready;
	await flush();

	assert.equal(root.interested("new"), true);
	assert.equal(root.interested("old"), false, "the old page's interest went with it");
});

test("maxPayload: an oversized message is dropped at the link, in either direction", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const atRoot: unknown[] = [];
	const atPod: unknown[] = [];
	const reported = faults(root);

	root.subscribe("up", (data) => { atRoot.push(data); });
	pod.subscribe("down", (data) => { atPod.push(data); });
	await Promise.all([root.link(a, { "maxPayload": 100 }).ready, pod.link(b).ready]);

	root.publish("down", "x".repeat(1000));
	root.publish("down", "small");
	pod.publish("up", "y".repeat(1000));
	pod.publish("up", "small");
	await flush();

	assert.deepEqual(atPod, ["small"]);
	assert.deepEqual(atRoot, ["small"]);
	assert.deepEqual(reported.map((fault) => fault.kind), ["payload", "payload"]);
});

test("backpressure: while a transport's backlog is past maxBacklog, messages are dropped — control still goes", async () => {
	const [a, b] = pipe();
	let backlog = 0;
	const slow: Transport = { ...a, "backlog": () => backlog };
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const seen: unknown[] = [];
	const reported = faults(root);

	pod.subscribe("x", (data) => { seen.push(data); });
	await Promise.all([root.link(slow, { "maxBacklog": 10 }).ready, pod.link(b).ready]);

	backlog = 100;
	root.publish("x", 1);
	root.subscribe("interest.still.flows", () => undefined);
	backlog = 0;
	root.publish("x", 2);
	await flush();

	assert.deepEqual(seen, [2]);
	assert.equal(reported[0]?.kind, "backlog");
	assert.equal(pod.interested("interest.still.flows"), true);
});

test("permissions intersect interest: a broad subscription behind a narrow allowance is asked for as the allowance", async () => {
	// page ─ referee ─ client: the client subscribes to everything, but may receive only its own state.
	const [pageEnd, refereeUp] = pipe();
	const [refereeDown, clientEnd] = pipe();
	const page = createHub({ "id": "page" });
	const referee = createHub({ "id": "referee" });
	const client = createHub({ "id": "client-0" });

	client.subscribe(">", () => undefined);
	await Promise.all([page.link(pageEnd).ready, referee.link(refereeUp).ready, referee.link(refereeDown, { "peer": "client-0", "permissions": { "subscribe": ["game.state.client-0"] } }).ready, client.link(clientEnd, { "uplink": true }).ready]);
	await flush();

	assert.equal(page.interested("game.state.client-0"), true);
	assert.equal(page.interested("game.state.client-1"), false, "the page isn't told the client wants what it can't have");
	assert.deepEqual(interestOf(page), ["game.state.client-0"]);
});

test("interest is narrowed to what a link may send, too", async () => {
	const [rootEnd, up] = pipe();
	const [down, peerEnd] = pipe();
	const root = createHub({ "id": "root" });
	const hub = createHub({ "id": "hub" });
	const peer = createHub({ "id": "p" });

	root.subscribe("$sys.log.>", () => undefined);
	await Promise.all([root.link(rootEnd).ready, hub.link(up).ready, hub.link(down, { "peer": "p", "permissions": { "publish": ["$sys.log.p"] } }).ready, peer.link(peerEnd).ready]);
	await flush();

	assert.equal(peer.interested("$sys.log.p"), true);
	assert.equal(peer.interested("$sys.log.q"), false);
});

test("subjects, patterns, ids and permissions are validated: thrown at locally, dropped from a peer", async () => {
	const hub = createHub({ "id": "hub" });

	assert.ok(!matches("a.>.c", "a.b.c"), "`>` only ends a pattern");
	assert.throws(() => hub.subscribe("a..b", () => undefined), TypeError);
	assert.throws(() => hub.subscribe("a.>.b", () => undefined), TypeError);
	assert.throws(() => hub.subscribe("", () => undefined), TypeError);
	assert.throws(() => { hub.publish("a.*"); }, TypeError);
	assert.throws(() => { hub.publish("a.b."); }, TypeError);
	assert.throws(() => createHub({ "id": "has.a.dot" }), TypeError);
	assert.throws(() => hub.link(pipe()[0], { "peer": "a.b" }), TypeError);
	assert.throws(() => hub.link(pipe()[0], { "permissions": { "publish": ["a.>.b"] } }), TypeError);
	assert.throws(() => hub.permit("anyone", { "subscribe": ["a..b"] }), TypeError);

	// From a peer: raw frames, as a hostile or buggy hub might send them.
	const [a, b] = pipe();
	const seen: unknown[] = [];
	const reported = faults(hub);

	hub.subscribe(">", (data) => { seen.push(data); });
	hub.link(a);
	b.listen(() => undefined);
	b.send({ "\0hub": { "hub": "hello", "id": "bad.id" } });
	b.send({ "\0hub": { "hub": "sub", "subject": "a.>.b" } });
	b.send({ "\0hub": { "subject": "a..b", "data": "bad" } });
	b.send({ "\0hub": { "subject": "a.*", "data": "wild" } });
	b.send({ "\0hub": { "subject": "ok", "data": "good" } });
	await flush();

	assert.deepEqual(seen, ["good"]);
	assert.equal(hub.inspect().links[0]?.peerId, undefined, "an invalid id is no name");
	assert.deepEqual(interestOf(hub), []);
	assert.equal(reported.filter((fault) => fault.kind === "frame").length, 4);
});

/** A connected pair of RTCDataChannel stand-ins: "connecting" until `open()`, text only, async delivery. */
function dataChannelPair() {
	class FakeChannel extends EventTarget {
		public readyState: RTCDataChannelState = "connecting";
		public bufferedAmount = 0;
		public peer: FakeChannel | undefined;
		public readonly sent: string[] = [];

		public send(data: string): void {
			if (this.readyState !== "open") {
				throw new Error("InvalidStateError: not open");
			}

			this.sent.push(data);
			setTimeout(() => { this.peer?.dispatchEvent(Object.assign(new Event("message"), { "data": data })); }, 0);
		}

		public close(): void {
			for (const end of [this, this.peer!]) {
				end.readyState = "closed";
				end.dispatchEvent(new Event("close"));
			}
		}
	}

	const [a, b] = [new FakeChannel(), new FakeChannel()];

	a.peer = b;
	b.peer = a;

	const open = (): void => {
		for (const end of [a, b]) {
			end.readyState = "open";
			end.dispatchEvent(new Event("open"));
		}
	};

	return { "a": a, "b": b, "open": open, "channels": [a as unknown as RTCDataChannel, b as unknown as RTCDataChannel] as const };
}

test("dataChannelTransport: hubs link over an RTCDataChannel — held until it opens, JSON-framed, unlinked when it closes", async () => {
	const { a, open, channels } = dataChannelPair();
	const referee = createHub({ "id": "referee" });
	const client = createHub({ "id": "client" });
	const seen: unknown[] = [];

	referee.subscribe("game.state", (data) => { seen.push(data); });

	// Linked while still connecting (a channel handed to a worker on creation): nothing sent yet, nothing lost.
	const ready = Promise.all([referee.link(dataChannelTransport(channels[0])).ready, client.link(dataChannelTransport(channels[1])).ready]);

	await flush();
	assert.equal(a.sent.length, 0, "nothing goes out on a channel that isn't open");
	open();
	await ready;

	client.publish("game.state", { "tick": 1, "units": [[1, 2, 3]] });
	await flush();
	assert.deepEqual(seen, [{ "tick": 1, "units": [[1, 2, 3]] }]);
	assert.ok(a.sent.every((text) => typeof text === "string"), "text frames: a data channel carries no structured clone");

	a.close();
	await flush();
	assert.equal(referee.inspect().links.length, 0);
	assert.equal(client.inspect().links.length, 0);
});

test("dataChannelTransport's backlog is the channel's buffered amount, plus what it holds until open", () => {
	const { a, channels } = dataChannelPair();
	const transport = dataChannelTransport(channels[0]);

	transport.send({ "x": 1 });
	assert.ok((transport.backlog?.() ?? 0) > 0, "held while connecting");
	a.readyState = "open";
	a.dispatchEvent(new Event("open"));
	a.bufferedAmount = 500;
	assert.equal(transport.backlog?.(), 500);
});
