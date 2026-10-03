/** WebRTC links (src/rtc.ts), against a stand-in RTCPeerConnection: node has none. What's checked is this module's own
 *  part — the offer/answer and candidate exchange, candidates held until their description, each channel handed over as
 *  it's made — and that two hubs then link over the channels. */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { answerLink, createHub, dataChannelTransport, joinLobby, localSignaling, offerLink } from "../src/index.ts";

class FakeChannel extends EventTarget {
	public readyState: RTCDataChannelState = "connecting";
	public bufferedAmount = 0;
	public peer: FakeChannel | undefined;
	public readonly label: string;

	public constructor(label: string) {
		super();
		this.label = label;
	}

	public send(data: string): void {
		setTimeout(() => { this.peer?.dispatchEvent(Object.assign(new Event("message"), { "data": data })); }, 0);
	}

	public open(): void {
		this.readyState = "open";
		this.dispatchEvent(new Event("open"));
	}
}

/** Enough of RTCPeerConnection for rtc.ts: an offer names its connection, so the answering one can find it. */
class FakeConnection extends EventTarget {
	private static count = 0;
	private static readonly offering = new Map<string, FakeConnection>();
	public connectionState: RTCPeerConnectionState = "new";
	public localDescription: { "type": string; "sdp": string; "toJSON": () => RTCSessionDescriptionInit } | null = null;
	public remoteDescription: RTCSessionDescriptionInit | null = null;
	public readonly candidates: RTCIceCandidateInit[] = [];
	private readonly id = "pc-" + (FakeConnection.count += 1);
	private channel: FakeChannel | undefined;

	public createDataChannel(label: string): FakeChannel {
		this.channel = new FakeChannel(label);

		return this.channel;
	}

	public async createOffer(): Promise<RTCSessionDescriptionInit> {
		FakeConnection.offering.set(this.id, this);

		return { "type": "offer", "sdp": this.id };
	}

	public async createAnswer(): Promise<RTCSessionDescriptionInit> {
		return { "type": "answer", "sdp": this.id };
	}

	public async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = { "type": description.type!, "sdp": description.sdp!, "toJSON": () => description };
		// Gathering starts at once: a candidate goes out before the description it belongs to has been sent.
		this.dispatchEvent(Object.assign(new Event("icecandidate"), { "candidate": { "toJSON": () => ({ "candidate": "host " + this.id }) } }));
	}

	public async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = description;

		if (description.type === "answer") {
			// This end offered: the answering end gets its channel, paired with this end's.
			const answering = new FakeChannel(this.channel!.label);

			answering.peer = this.channel;
			this.channel!.peer = answering;
			this.answerer!.dispatchEvent(Object.assign(new Event("datachannel"), { "channel": answering }));

			for (const connection of [this, this.answerer!]) {
				connection.connectionState = "connected";
				connection.dispatchEvent(new Event("connectionstatechange"));
			}

			answering.open();
			this.channel!.open();
		} else {
			FakeConnection.offering.get(description.sdp!)!.answerer = this;
		}
	}

	public async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (this.remoteDescription === null) {
			throw new Error("InvalidStateError: no remote description");
		}

		this.candidates.push(candidate);
	}

	public close(): void {
		this.connectionState = "closed";
	}

	private answerer: FakeConnection | undefined;
}

/** RTCPeerConnection, stood in for while a test runs: the connections made. */
function standIn(t: { "after": (fn: () => void) => void }): FakeConnection[] {
	const globals = globalThis as { "RTCPeerConnection"?: unknown };
	const connections: FakeConnection[] = [];

	globals.RTCPeerConnection = class extends FakeConnection {
		public constructor() {
			super();
			connections.push(this);
		}
	};
	t.after(() => { delete globals.RTCPeerConnection; });

	return connections;
}

/** Two hubs linked over a pair of channels pass a message. */
async function carries(channels: RTCDataChannel[]): Promise<boolean> {
	const one = createHub({ "id": "one" });
	const two = createHub({ "id": "two" });
	const seen: unknown[] = [];

	one.subscribe("game.state", (data) => { seen.push(data); });
	await Promise.all([one.link(dataChannelTransport(channels[0])).ready, two.link(dataChannelTransport(channels[1])).ready]);
	two.publish("game.state", 1);
	await new Promise((resolve) => { setTimeout(resolve, 20); });

	return seen.length === 1;
}

test("rtc: an offer and its answer over a signaling path hand each end its channel, and two hubs link over them", async (t) => {
	const connections = standIn(t);

	const [offering, answering] = localSignaling();
	let closed = 0;
	const taken: RTCDataChannel[] = [];

	offerLink("game.link.player-1", { ...offering, "close": () => { closed += 1; } }, (channel) => { taken.push(channel); });
	assert.equal(taken.length, 1, "the offering end's channel, at once — the only time it could be transferred");
	answerLink(answering, (channel) => { taken.push(channel); });

	const referee = createHub({ "id": "referee" });
	const client = createHub({ "id": "client" });

	await new Promise((resolve) => { setTimeout(resolve, 20); });
	assert.equal(taken.length, 2, "and the answering end's, as it arrived");
	assert.equal(taken[1].label, "game.link.player-1");
	assert.deepEqual(connections.map((connection) => connection.candidates.length), [1, 1], "each end's candidate added — the early one held until its description");
	assert.ok(closed > 0, "signaling closed once connected");

	const seen: unknown[] = [];

	referee.subscribe("game.state", (data) => { seen.push(data); });
	await Promise.all([referee.link(dataChannelTransport(taken[0])).ready, client.link(dataChannelTransport(taken[1])).ready]);
	client.publish("game.state", { "tick": 1 });
	await new Promise((resolve) => { setTimeout(resolve, 20); });
	assert.deepEqual(seen, [{ "tick": 1 }]);
});

test("joinLobby: the first tab hosts, the next are players by the lowest free id, and each player's link reaches the host", async (t) => {
	standIn(t);

	// Tabs of one browser, as one process sees them: one origin's locks, one BroadcastChannel namespace.
	const host = await joinLobby("game", "lobby-test");
	const first = await joinLobby("game", "lobby-test");
	const second = await joinLobby("game", "lobby-test");

	assert.equal(host.role, "host");
	assert.equal(host.peer, "player-0");
	assert.deepEqual([first.role, first.peer, second.role, second.peer], ["player", "player-1", "player", "player-2"]);

	const hostEnds = new Map<string, RTCDataChannel>();

	if (host.role !== "host" || second.role !== "player") {
		return;
	}

	host.onPlayer((peer, makeLink) => { makeLink((channel) => { hostEnds.set(peer, channel); }); });

	let playerEnd: RTCDataChannel | undefined;

	await second.link((channel) => { playerEnd = channel; });
	await new Promise((resolve) => { setTimeout(resolve, 20); });
	assert.equal(hostEnds.get("player-2")?.label, "game.lobby-test.link.player-2", "the host's end, labelled for its player");
	assert.equal(playerEnd?.label, "game.lobby-test.link.player-2");
	assert.ok(await carries([hostEnds.get("player-2")!, playerEnd]), "two hubs link over the pair");
});
