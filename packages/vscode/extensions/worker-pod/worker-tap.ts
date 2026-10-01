/**
 * The tap in every worker a preview starts (the dev server puts it first in a worker's entry script — node-worker.ts):
 * the same console / error capture and WebSocket gate as a page's (tap-shared.ts). A worker can't reach the editor's
 * window, so it reports over a same-origin BroadcastChannel, tagged with its tab and port (from its own address) and
 * its window (from its page's tag, page-tap.ts) — so only its editor's shell takes it, for that window.
 */
import type { Decide, TapRecord } from "./tap-shared";
import { VIRTUAL_RE, WINDOW_PARAM, WORKER_TAP_CHANNEL } from "../../virtual-path";
import { installConsoleTap, installSocketGate } from "./tap-shared";

function install(): void {
	const self = globalThis as { "__obsTap"?: true };

	if (self.__obsTap === true) {
		return;
	}

	self.__obsTap = true;

	const match = VIRTUAL_RE.exec(location.pathname);
	const tab = match?.[1];
	const port = match === null ? undefined : Number(match[2]);
	const worker = match?.[3] || location.pathname;
	const window = new URLSearchParams(location.hash.slice(1)).get(WINDOW_PARAM) ?? undefined;
	let channel: BroadcastChannel;

	try {
		channel = new BroadcastChannel(WORKER_TAP_CHANNEL);
	} catch {
		return;
	}

	const me = crypto.randomUUID();
	const send = (record: TapRecord): void => {
		try {
			channel.postMessage({ "channel": "obs-log", "tab": tab, "port": port, "window": window, "record": { ...record, "attrs": { "worker": worker, ...record.attrs } } });
		} catch { /* a tap never breaks the app */ }
	};
	const pending = new Map<string, (allow: boolean) => void>();

	channel.addEventListener("message", (event: MessageEvent) => {
		const data = event.data as { "channel"?: string; "to"?: string; "id"?: string; "allow"?: boolean } | null;
		const resolve = data?.channel === "cap-decision" && data.to === me && data.id !== undefined ? pending.get(data.id) : undefined;

		if (resolve !== undefined) {
			pending.delete(data!.id!);
			resolve(data!.allow === true);
		}
	});

	const decide: Decide = async (kind, resource) => new Promise((resolve) => {
		const id = crypto.randomUUID(); // unguessable: only the shell can answer it

		pending.set(id, resolve);

		try {
			channel.postMessage({ "channel": "cap-decide", "tab": tab, "port": port, "window": window, "from": me, "id": id, "kind": kind, "resource": resource });
		} catch {
			pending.delete(id);
			resolve(false);

			return;
		}

		// Unanswered ⇒ fail closed.
		setTimeout(() => {
			if (pending.delete(id)) {
				resolve(false);
			}
		}, 300_000);
	});

	installConsoleTap(send);
	installSocketGate(decide);
}

install();
