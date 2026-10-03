/**
 * WebRTC data channels between pages, for hubs to link over (dataChannelTransport) — made where they can be: there's no
 * RTCPeerConnection in a worker, so the page that owns a worker makes its end's connection and hands the data channel
 * to the worker (a channel can be transferred only in the task it's created or arrives in), whose hub links over it.
 * The pages only signal; what the hubs say never passes through them.
 *
 * Signaling — how the two ends trade their offer, answer and candidates — is a seam: `localSignaling` within one page,
 * `joinLobby` between tabs of one browser, anything else (a relay, a pasted invite) between machines. With no ICE
 * servers (the default) host candidates must do: the same machine, or the same network.
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

/**
 * How a lobby gives a page one end of a link, however it's made (offerLink over a signaling path, or a library that
 * makes its own connections): call it with `take`, and `take` gets the end's data channel in the very task the channel
 * is made or arrives — the only time it can be transferred to a worker.
 */
export type MakeLink = (take: (channel: RTCDataChannel) => void) => RtcLink;

/** On a match's lobby channel. */
type LobbyMessage =
	/** player → host: link me, as `link`. Repeated until accepted. */
	| { "type": "connect"; "peer": string; "link": string }
	/** host → player: accepted — its signals follow. */
	| { "type": "accepted"; "link": string }
	/** Either way: a WebRTC signal for link `link`. */
	| { "type": "signal"; "link": string; "from": "host" | "player"; "signal": Signal };

/** Signaling for link `link` over the lobby, as `me`: it hears only the other end's signals for that link — and holds
 *  any that come before it has a handler — until the link's connection is up or gone (connect closes it). */
function lobbySignaling(lobby: BroadcastChannel, link: string, me: "host" | "player"): Signaling {
	let handler: ((signal: Signal) => void) | undefined;
	const early: Signal[] = [];
	const heard = (event: MessageEvent<LobbyMessage>): void => {
		const message = event.data;

		if (message.type === "signal" && message.link === link && message.from !== me) {
			if (handler === undefined) {
				early.push(message.signal);
			} else {
				handler(message.signal);
			}
		}
	};

	lobby.addEventListener("message", heard);

	return {
		"send": (signal) => { lobby.postMessage({ "type": "signal", "link": link, "from": me, "signal": signal } satisfies LobbyMessage); },
		"onSignal": (next) => {
			handler = next;

			for (const signal of early.splice(0)) {
				next(signal);
			}
		},
		"close": () => { lobby.removeEventListener("message", heard); }
	};
}

/** A tab's place in a match (joinLobby): its `peer` id — `player-0` for the host — and, for the host, each player's
 *  link as it asks for one; for a player, a way to ask, and word of the host leaving. */
export type Lobby =
	| { "role": "host"; "peer": string; /** Each time a player needs a link: the host's end of it. */ "onPlayer": (handler: (peer: string, link: MakeLink) => void) => void }
	| { "role": "player"; "peer": string; /** A fresh link to the host: this end (resolves once the host has accepted it). */ "link": (take: (channel: RTCDataChannel) => void) => Promise<RtcLink>; "onHostLeft": (handler: () => void) => void };

/** How often a player repeats an unanswered `connect` (a host still starting up hasn't heard it). */
const LOBBY_RETRY_MS = 250;
const PLAYER = /^player-[1-9]\d*$/u;

function remembered(key: string): string | undefined {
	try {
		return sessionStorage.getItem(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function remember(key: string, value: string): void {
	try {
		sessionStorage.setItem(key, value);
	} catch { /* no storage: a reload joins as a new player */ }
}

/** Take lock `name` if it's free, and hold it for the tab's life (a tab leaves a match by going). Resolves whether it
 *  got it. */
async function hold(name: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		void navigator.locks.request(name, { "ifAvailable": true }, async (lock) => {
			resolve(lock !== null);

			if (lock !== null) {
				await new Promise<never>(() => { /* never resolves: the browser releases it when the tab goes */ });
			}
		});
	});
}

/**
 * Join match `match` among this browser's tabs: host it if nobody does yet, else join it as a player. Everything is
 * scoped to the origin (one server), not a URL, and named `<namespace>.<match>.…`:
 *
 * - **Who hosts:** the Web Lock `….host`. The first tab to take it hosts; the browser releases it when that tab goes
 *   (closed, reloaded, crashed), which is how players learn the host left (`onHostLeft`).
 * - **Who's who:** the Web Lock `….player-N`, held for the tab's life: the id it had before a reload if it's free (in
 *   sessionStorage), else the lowest free one — atomically, with no one to ask. The host is `player-0`.
 * - **Introductions and signaling:** the BroadcastChannel `….lobby`. A player asks for a link under a fresh id; the host
 *   accepts, and the two trade the link's offer, answer and candidates over the channel (offerLink, answerLink). The
 *   data channel is labelled `….link.<peer>`.
 *
 * Same-origin tabs are trusted: any of them can open the lobby channel, take a lock or claim a player id.
 */
export async function joinLobby(namespace: string, match: string): Promise<Lobby> {
	const prefix = `${namespace}.${match}`;
	const peerKey = `${prefix}.peer`;
	const hostLock = `${prefix}.host`;
	const lobby = new BroadcastChannel(`${prefix}.lobby`);

	if (await hold(hostLock)) {
		const accepted = new Set<string>();
		let onPlayer: (peer: string, link: MakeLink) => void = () => undefined;

		lobby.addEventListener("message", (event: MessageEvent<LobbyMessage>) => {
			const message = event.data;

			if (message.type !== "connect" || !PLAYER.test(message.peer)) {
				return;
			}

			// A repeat (our answer crossed its retry) is answered again, not linked again.
			if (!accepted.has(message.link)) {
				accepted.add(message.link);

				const signaling = lobbySignaling(lobby, message.link, "host");

				onPlayer(message.peer, (take) => offerLink(`${prefix}.link.${message.peer}`, signaling, take));
			}

			lobby.postMessage({ "type": "accepted", "link": message.link } satisfies LobbyMessage);
		});
		remember(peerKey, "player-0");

		return { "role": "host", "peer": "player-0", "onPlayer": (handler) => { onPlayer = handler; } };
	}

	// A player: the id it had before a reload if that's free, else the lowest free one.
	const want = remembered(peerKey);
	let peer = want !== undefined && PLAYER.test(want) && await hold(`${prefix}.${want}`) ? want : undefined;

	for (let index = 1; peer === undefined; index += 1) {
		if (await hold(`${prefix}.player-${index}`)) {
			peer = `player-${index}`;
		}
	}

	remember(peerKey, peer);

	// The host's lock comes free when the host goes: wait for it (and let it straight go — this tab doesn't host).
	let hostLeft = false;
	let onHostLeft = (): void => undefined;

	void navigator.locks.request(hostLock, { "mode": "shared" }, () => {
		hostLeft = true;
		onHostLeft();
	});

	return {
		"role": "player",
		"peer": peer,
		"link": async (take) => {
			const link = crypto.randomUUID();
			// Listening before asking: the host's offer can follow its acceptance straight away.
			const signaling = lobbySignaling(lobby, link, "player");

			await new Promise<void>((resolve) => {
				const send = (): void => { lobby.postMessage({ "type": "connect", "peer": peer, "link": link } satisfies LobbyMessage); };
				const timer = setInterval(send, LOBBY_RETRY_MS);
				const answered = (event: MessageEvent<LobbyMessage>): void => {
					if (event.data.type === "accepted" && event.data.link === link) {
						clearInterval(timer);
						lobby.removeEventListener("message", answered);
						resolve();
					}
				};

				lobby.addEventListener("message", answered);
				send();
			});

			return answerLink(signaling, take);
		},
		"onHostLeft": (handler) => {
			onHostLeft = handler;

			if (hostLeft) {
				handler();
			}
		}
	};
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
