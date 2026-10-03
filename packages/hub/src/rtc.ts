/**
 * WebRTC data channels between pages, for hubs to link over (dataChannelTransport) — made where they can be: there's no
 * RTCPeerConnection in a worker, so the page that owns a worker makes its end's connection and hands the data channel
 * to the worker (a channel can be transferred only in the task it's created or arrives in), whose hub links over it.
 * The pages only signal; what the hubs say never passes through them.
 *
 * Signaling — how the two ends trade their offer, answer and candidates — is a seam: `localSignaling` within one page,
 * anything else (a lobby's BroadcastChannel, a relay, a pasted invite) between pages. With no ICE servers (the default)
 * host candidates must do: the same machine, or the same network.
 */

export type Signal = { "description": RTCSessionDescriptionInit } | { "candidate": RTCIceCandidateInit };

export interface Signaling {
	"send": (signal: Signal) => void;
	/** The other end's signals; any that came before a handler was set go to it then. */
	"onSignal": (handler: (signal: Signal) => void) => void;
	/** Done with: the connection is up, or gone — nothing more to signal. Called once or more. */
	"close"?: () => void;
}

/** One end's connection: closing it ends the link (both ends' data channels close, and their hubs unlink). */
export interface RtcLink {
	"close": () => void;
}

/** A peer connection that answers `signaling`: a remote description (answering an offer), and candidates — held until
 *  the description they belong to has been set. */
function connect(signaling: Signaling, config: RTCConfiguration): RTCPeerConnection {
	const connection = new RTCPeerConnection(config);
	const early: RTCIceCandidateInit[] = [];

	connection.addEventListener("connectionstatechange", () => {
		if (["connected", "failed", "closed"].includes(connection.connectionState)) {
			signaling.close?.();
		}
	});

	connection.addEventListener("icecandidate", (event) => {
		if (event.candidate !== null) {
			signaling.send({ "candidate": event.candidate.toJSON() });
		}
	});
	signaling.onSignal((signal) => {
		void (async () => {
			if ("description" in signal) {
				await connection.setRemoteDescription(signal.description);

				for (const candidate of early.splice(0)) {
					await connection.addIceCandidate(candidate);
				}

				if (signal.description.type === "offer") {
					await connection.setLocalDescription(await connection.createAnswer());
					signaling.send({ "description": connection.localDescription!.toJSON() });
				}
			} else if (connection.remoteDescription === null) {
				early.push(signal.candidate);
			} else {
				await connection.addIceCandidate(signal.candidate);
			}
		})().catch(() => undefined); // a closed connection: nothing left to signal
	});

	return connection;
}

function closer(connection: RTCPeerConnection, signaling: Signaling): RtcLink {
	return {
		"close": () => {
			connection.close();
			signaling.close?.();
		}
	};
}

/** The offering end: make the connection and its data channel, `label`led (reliable and ordered: the default, as
 *  dataChannelTransport needs), and hand the channel to `take` at once — before anything's sent on it, the only time
 *  it can be transferred to a worker. */
export function offerLink(label: string, signaling: Signaling, take: (channel: RTCDataChannel) => void, config: RTCConfiguration = { "iceServers": [] }): RtcLink {
	const connection = connect(signaling, config);

	take(connection.createDataChannel(label));
	void (async () => {
		await connection.setLocalDescription(await connection.createOffer());
		signaling.send({ "description": connection.localDescription!.toJSON() });
	})().catch(() => undefined);

	return closer(connection, signaling);
}

/** The answering end: answer the offer, and hand the data channel to `take` the moment it arrives. */
export function answerLink(signaling: Signaling, take: (channel: RTCDataChannel) => void, config: RTCConfiguration = { "iceServers": [] }): RtcLink {
	const connection = connect(signaling, config);

	connection.addEventListener("datachannel", (event) => { take(event.channel); }, { "once": true });

	return closer(connection, signaling);
}

/** Two ends of a signaling path within one page. */
export function localSignaling(): [Signaling, Signaling] {
	const end = () => {
		let handler: ((signal: Signal) => void) | undefined;
		const early: Signal[] = [];

		return {
			"deliver": (signal: Signal): void => {
				if (handler === undefined) {
					early.push(signal);
				} else {
					handler(signal);
				}
			},
			"onSignal": (next: (signal: Signal) => void): void => {
				handler = next;

				for (const signal of early.splice(0)) {
					next(signal);
				}
			}
		};
	};
	const [a, b] = [end(), end()];

	return [
		{ "send": (signal) => { queueMicrotask(() => { b.deliver(signal); }); }, "onSignal": a.onSignal },
		{ "send": (signal) => { queueMicrotask(() => { a.deliver(signal); }); }, "onSignal": b.onSignal }
	];
}
