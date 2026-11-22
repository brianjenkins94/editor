import type { Transport } from "@brianjenkins94/hub";

const WIRE = "\0paneLink";

interface PaneFrame { [WIRE]: string; "msg": unknown }

function isFrame(data: unknown, channel: string): data is PaneFrame {
	return typeof data === "object" && data !== null && (data as PaneFrame)[WIRE] === channel;
}

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
						target = event.source as Window;
					}

					onMessage(event.data.msg);
				}
			};

			globalThis.addEventListener("message", handler as EventListener);

			return () => {
				globalThis.removeEventListener("message", handler as EventListener);
			};
		}
	};
}

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

			return () => {
				globalThis.removeEventListener("message", handler as EventListener);
			};
		}
	};
}
