/**
 * The channels a hub doesn't carry, observed: BroadcastChannels, Web Locks and WebRTC peer connections — and payload
 * capture, a viewer's opt-in, keeping what each sampled message carried.
 */
import type { ArchNodeSpec, ArchReport, ArchSink, TrafficKind } from "../src/arch.ts";
import * as assert from "node:assert/strict";
import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import { installNetworkProbes } from "../src/arch-probes.ts";
import { collectArchReports, createArchReporter, previewPayload, requestArchSync } from "../src/arch.ts";

interface Recorded { "from": string; "to": string; "kind": TrafficKind; "label": string; "payload"?: unknown }

const recorded: Recorded[] = [];
const spawned: ArchNodeSpec[] = [];
const sink: ArchSink = {
	"self": "page",
	"declare": () => undefined,
	"spawn": (spec) => { spawned.push(spec); },
	"terminate": () => undefined,
	"state": () => undefined,
	"record": (from, to, kind, label, _bytes, _count, payload) => { recorded.push({ "from": from, "to": to, "kind": kind, "label": label, "payload": payload }); }
};

// A stand-in RTCPeerConnection (node has none): enough of one for the probe to wrap.
class FakeDataChannel extends EventTarget {
	public readonly sent: unknown[] = [];
	public readonly label: string;

	public constructor(label: string) {
		super();
		this.label = label;
	}

	public send(data: unknown): void {
		this.sent.push(data);
	}
}

class FakePeerConnection extends EventTarget {
	public signalingState = "stable";

	public createDataChannel(label: string): FakeDataChannel {
		return new FakeDataChannel(label);
	}

	public async createOffer(): Promise<{ "type": string; "sdp": string }> {
		return { "type": "offer", "sdp": "v=0" };
	}

	public async setLocalDescription(_description: unknown): Promise<void> { /* stand-in */ }
	public async setRemoteDescription(_description: unknown): Promise<void> { /* stand-in */ }
	public async addIceCandidate(_candidate: unknown): Promise<void> { /* stand-in */ }
	public async createAnswer(): Promise<{ "type": string; "sdp": string }> {
		return { "type": "answer", "sdp": "v=0" };
	}

	public close(): void { /* stand-in */ }
}

(globalThis as { "RTCPeerConnection"?: unknown }).RTCPeerConnection = FakePeerConnection;
installNetworkProbes(sink);

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("a BroadcastChannel's messages, each way — not a hub link riding one (the hub tap counts that)", async () => {
	recorded.length = 0;

	const name = "netsim.m.lobby";
	const [a, b] = [new BroadcastChannel(name), new BroadcastChannel(name)];

	a.postMessage({ "type": "connect", "peer": "player-1" });
	a.postMessage({ "\0hub": { "hub": "hello", "id": "x" } });
	await wait(20);

	assert.deepEqual(recorded.map(({ from, to, label }) => [from, to, label]), [["page", "channel:netsim.m.lobby", "connect"], ["channel:netsim.m.lobby", "page", "connect"]]);
	assert.deepEqual(recorded[0]?.payload, { "type": "connect", "peer": "player-1" }, "what it carried, for capture");
	assert.equal(spawned.filter((spec) => spec.id === "channel:netsim.m.lobby").length, 1, "one node per channel name");
	a.close();
	b.close();
});

test("a Web Lock asked for, granted, released — and one that's taken, unavailable", async () => {
	recorded.length = 0;

	const name = "netsim." + crypto.randomUUID() + ".host";
	let release = (): void => undefined;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const first = navigator.locks.request(name, async () => held);

	await wait(10);
	await navigator.locks.request(name, { "ifAvailable": true }, async (lock) => { assert.equal(lock, null); });
	release();
	await first;

	assert.deepEqual(recorded.map(({ label }) => label), ["request (exclusive)", "granted", "request (exclusive, if available)", "unavailable", "released"]);
	assert.ok(recorded.every((entry) => [entry.from, entry.to].includes("lock:netsim.*.host")), "one node per lock, its id folded: " + JSON.stringify(recorded));
});

test("a WebRTC peer connection: its signaling (with the SDP), its states, its data channels' messages", async () => {
	recorded.length = 0;

	const connection = new RTCPeerConnection();
	const channel = connection.createDataChannel("game");
	const offer = await connection.createOffer();

	await connection.setLocalDescription(offer);
	channel.send(JSON.stringify({ "type": "commands", "seq": 1 }));
	channel.dispatchEvent(new MessageEvent("message", { "data": JSON.stringify({ "type": "state" }) }));
	(connection as unknown as FakePeerConnection).signalingState = "have-local-offer";
	connection.dispatchEvent(new Event("signalingstatechange"));

	assert.deepEqual(recorded.map(({ from, to, label }) => [from, to, label]), [
		["page", "rtc:1", "createOffer"],
		["page", "rtc:1", "setLocalDescription (offer)"],
		["page", "rtc:1", "game: commands"],
		["rtc:1", "page", "game: state"],
		["page", "rtc:1", "signaling: have-local-offer"]
	]);
	assert.deepEqual(recorded[1]?.payload, { "type": "offer", "sdp": "v=0" }, "the offer's SDP, for capture");
	assert.deepEqual((channel as unknown as FakeDataChannel).sent, [JSON.stringify({ "type": "commands", "seq": 1 })], "the message still went");
});

test("payload capture is opt-in: off, samples carry no payload; on (a viewer asks), a size-capped preview", async () => {
	const [up, down] = pipe();
	const viewer = createHub({ "id": "viewer" });
	const page = createHub({ "id": "page" });
	const reports: ArchReport[] = [];

	collectArchReports(viewer, (report) => { reports.push(report); });
	await Promise.all([viewer.link(up).ready, page.link(down).ready]);

	const reporter = createArchReporter(page);
	const payloads = () => reports.flatMap((report) => report.samples ?? []).filter((sample) => sample.label === "game.move").map((sample) => sample.payload);

	viewer.subscribe("game.move", () => undefined);
	await wait(50);
	page.publish("game.move", { "x": 1 });
	await wait(400);
	assert.deepEqual(payloads(), [undefined], "off by default");

	requestArchSync(viewer, { "capture": true });
	await wait(50);
	page.publish("game.move", { "x": 2 });
	await wait(400);
	assert.deepEqual(payloads(), [undefined, "{\"x\":2}"]);

	requestArchSync(viewer, { "capture": false });
	await wait(50);
	page.publish("game.move", { "x": 3 });
	await wait(400);
	assert.deepEqual(payloads(), [undefined, "{\"x\":2}", undefined], "and off again");
	reporter.dispose();
});

test("a captured payload's preview: JSON, binary as its size, capped", () => {
	assert.equal(previewPayload({ "a": 1 }), "{\"a\":1}");
	assert.equal(previewPayload({ "bytes": new Uint8Array(4) }), "{\"bytes\":\"<Uint8Array 4 bytes>\"}");
	assert.equal(previewPayload("x".repeat(10), 4), "xxxx…");
	assert.equal(previewPayload(undefined), "undefined");
});
