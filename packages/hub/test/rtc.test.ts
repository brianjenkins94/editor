/** WebRTC links (src/rtc.ts), against a stand-in RTCPeerConnection: node has none. What's checked is this module's own
 *  part — the offer/answer and candidate exchange, candidates held until their description, each channel handed over as
 *  it's made — and that two hubs then link over the channels. */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { answerLink, createHub, dataChannelTransport, localSignaling, offerLink } from "../src/index.ts";

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

test("rtc: an offer and its answer over a signaling path hand each end its channel, and two hubs link over them", async (t) => {
	const globals = globalThis as { "RTCPeerConnection"?: unknown };
	const connections: FakeConnection[] = [];

	globals.RTCPeerConnection = class extends FakeConnection {
		public constructor() {
			super();
			connections.push(this);
		}
	};
	t.after(() => { delete globals.RTCPeerConnection; });

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
