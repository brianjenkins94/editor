/**
 * Pane link — hub transports for the host ⇄ pane (workbench iframe, later preview) window boundary.
 *
 * Replaces the old bespoke pane-bus: the boot handshake and log federation now ride ONE hub link over these
 * transports instead of a separate envelope bus plus a MessagePort. The only thing hub's built-in `windowTransport`
 * couldn't do is **retarget**: a pane can be popped out into its own window, and the host must then route to that
 * window without recreating the iframe (which would reload the pane and drop its state). `windowServerTransport`
 * (host side) tracks the pane's live window as `event.source` on every inbound frame — the popout trick, now a
 * plain hub transport. Identity-from-URL (`?pane=<id>`) becomes the `channel`, so a reloaded/popped pane re-pairs.
 *
 * Frames are wrapped `{ [WIRE]: channel, msg }` so this link is distinguishable from the shell↔app `windowTransport`
 * on the same window (that one is filtered by source; this one by channel), and foreign postMessages (HMR, devtools)
 * are ignored. `msg` is hub's own already-wrapped payload — we don't look inside it.
 */
import type { Transport } from "@brianjenkins94/hub";

/** Namespaced wire discriminator for pane-link frames (distinct from hub's own internal wrapper key). */
const WIRE = "\0paneLink";

interface PaneFrame { [WIRE]: string; "msg": unknown }

function isFrame(data: unknown, channel: string): data is PaneFrame {
	return typeof data === "object" && data !== null && (data as PaneFrame)[WIRE] === channel;
}

/**
 * HOST side. Delivers frames tagged `channel` to hub and, on each one, retargets sends to whichever window sent it
 * (the iframe now, a popped-out window later). Before the pane has said anything, sends go to `getFallbackTarget()`
 * (the iframe's contentWindow) — a first send may be dropped, which hub's `hello` handshake recovers when the pane
 * links and re-advertises.
 */
export function windowServerTransport(channel: string, getFallbackTarget: () => Window | undefined): Transport {
	let target: Window | undefined;

	return {
		"send": (message) => {
			const win = target ?? getFallbackTarget();

			win?.postMessage({ [WIRE]: channel, "msg": message } satisfies PaneFrame, "*");
		},
		"listen": (onMessage) => {
			const handler = (event: MessageEvent): void => {
				if (isFrame(event.data, channel)) {
					if (event.source !== null) {
						target = event.source as Window; // re-pair to the pane's current window
					}

					onMessage(event.data.msg);
				}
			};

			globalThis.addEventListener("message", handler as EventListener);

			return () => globalThis.removeEventListener("message", handler as EventListener);
		}
	};
}

/** PANE side. Talks to a fixed `host` window (our parent, or opener when popped out), tagged `channel`. */
export function windowClientTransport(channel: string, host: Window): Transport {
	return {
		"send": (message) => { host.postMessage({ [WIRE]: channel, "msg": message } satisfies PaneFrame, "*"); },
		"listen": (onMessage) => {
			const handler = (event: MessageEvent): void => {
				if (event.source === host && isFrame(event.data, channel)) {
					onMessage(event.data.msg);
				}
			};

			globalThis.addEventListener("message", handler as EventListener);

			return () => globalThis.removeEventListener("message", handler as EventListener);
		}
	};
}
