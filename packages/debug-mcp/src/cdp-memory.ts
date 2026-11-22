/**
 * Memory by realm, read through the browser's DevTools protocol where it has an endpoint: each linked tab's page and the
 * workers and frames under it, their JavaScript heap (`Runtime.getHeapUsage`'s usedSize) and their ArrayBuffers' backing
 * stores (backingStorageSize — a SharedArrayBuffer file system lives there, not on the heap), filed as the tab's `cdp`
 * source on its metrics plane (`cdp:heap.<realm>`, `cdp:backing.<realm>`, each with a `total`).
 *
 * The page's own gauge (observability's memoryGauge) is `measureUserAgentSpecificMemory`, which Brave never resolves and
 * the desktop app's pane hasn't got: this reads the same from outside, in any Chromium started with
 * `--remote-debugging-port`. Only the editor tabs linked here are attached to, never the browser's other pages; nothing is
 * read from them but those two numbers.
 */
import type { MetricsSample } from "../../observability/src/metrics.ts";

/** Where to look, when not told: Chromium's usual DevTools port. */
const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
/** How long to wait before looking again for an endpoint that wasn't there. */
const RETRY_MS = 30_000;
/** How long one realm's reading may take (a worker busy in a long task answers late; it's left out of that sample). */
const READ_MS = 3000;

interface TargetInfo { "targetId": string; "type": string; "url": string; "title": string }

interface Attached { "target": TargetInfo; "page": string }

interface Message { "id"?: number; "method"?: string; "params"?: Record<string, unknown>; "result"?: Record<string, unknown>; "error"?: { "message": string }; "sessionId"?: string }

export interface CdpMemoryOptions {
	/** The DevTools HTTP endpoint (`http://127.0.0.1:9222`). Default: DEBUG_MCP_CDP, else that. */
	"endpoint"?: string;
	"everyMs"?: number;
	/** The editor tabs linked now, by their address bar's URL. */
	"linked": () => { "tab": string; "url": string }[];
	/** File a tab's sample. */
	"file": (tab: string, sample: MetricsSample) => void;
	/** Say something worth keeping (connected, lost). */
	"say": (message: string) => void;
}

export interface CdpMemory {
	/** The endpoint it reads through now, or undefined while it has none. */
	"via": () => string | undefined;
	"close": () => void;
}

/** A realm's name in a sample: the page itself, a frame by its address, a worker by its name, else its script's file (an
 *  editor worker loaded through a bootstrap names its script in the fragment). */
export function realmOf(target: TargetInfo): string {
	if (target.type === "page") {
		return "page";
	}

	const named = target.title !== "" && !target.title.includes("/") && !target.title.includes(":") ? target.title : undefined;

	if (named !== undefined) {
		return named;
	}

	const [address = "", fragment = ""] = target.url.split("#");
	const script = (fragment.includes("/") ? fragment : address).split("?")[0] ?? "";
	const file = script.split("/").filter(Boolean).at(-1) ?? target.type;

	return target.type === "iframe" ? `frame:${file}` : file;
}

/** The sample of one tab's realms: each one's heap and backing stores (MB), named apart (`~2` for a second of a name). */
export function sampleOf(readings: { "target": TargetInfo; "used": number; "backing": number }[], t: number): MetricsSample {
	const values: Record<string, number> = {};
	const seen = new Map<string, number>();
	let heap = 0;
	let backing = 0;

	for (const reading of [...readings].sort((one, other) => (one.target.type === "page" ? -1 : other.target.type === "page" ? 1 : one.target.url.localeCompare(other.target.url)))) {
		const base = realmOf(reading.target);
		const count = (seen.get(base) ?? 0) + 1;
		const name = count === 1 ? base : `${base}~${String(count)}`;

		seen.set(base, count);
		values[`heap.${name}`] = reading.used / 1048576;
		values[`backing.${name}`] = reading.backing / 1048576;
		heap += reading.used;
		backing += reading.backing;
	}

	return { "source": "cdp", "t": t, "values": { ...values, "heap.total": heap / 1048576, "backing.total": backing / 1048576 } };
}

/** The same page, give or take its fragment (a tab's URL was read at its last discovery). */
const samePage = (one: string, other: string): boolean => one === other || one.split("#")[0] === other.split("#")[0];

export function cdpMemory({ endpoint = process.env["DEBUG_MCP_CDP"] ?? DEFAULT_ENDPOINT, everyMs = 5000, linked, file, say }: CdpMemoryOptions): CdpMemory {
	let socket: WebSocket | undefined;
	let connecting = false;
	let retryAt = 0;
	let closed = false;
	let nextId = 0;
	const pending = new Map<number, (message: Message) => void>();
	// (each attached target by its session, and the page it's under: a worker attached from a page's session is that page's)
	const sessions = new Map<string, Attached>();

	const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Message> => new Promise((resolve) => {
		if (socket?.readyState !== WebSocket.OPEN) {
			resolve({ "error": { "message": "not connected" } });

			return;
		}

		nextId += 1;

		const id = nextId;
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve({ "error": { "message": "no answer" } });
		}, READ_MS);

		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		socket.send(JSON.stringify({ "id": id, "method": method, "params": params, ...sessionId === undefined ? {} : { "sessionId": sessionId } }));
	});

	const onMessage = (message: Message): void => {
		if (message.id !== undefined) {
			pending.get(message.id)?.(message);
			pending.delete(message.id);

			return;
		}

		if (message.method === "Target.attachedToTarget") {
			const { sessionId, targetInfo } = message.params as { "sessionId": string; "targetInfo": TargetInfo };
			const parent = message.sessionId === undefined ? undefined : sessions.get(message.sessionId);

			sessions.set(sessionId, { "target": targetInfo, "page": parent?.page ?? targetInfo.targetId });
			// (its own workers and frames too, attached under it; none waits for a debugger)
			void send("Target.setAutoAttach", { "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }, sessionId);
			void send("Runtime.runIfWaitingForDebugger", {}, sessionId);
		} else if (message.method === "Target.detachedFromTarget") {
			sessions.delete((message.params as { "sessionId": string }).sessionId);
		}
	};

	const connect = async (): Promise<void> => {
		connecting = true;

		try {
			const version = await fetch(`${endpoint}/json/version`, { "signal": AbortSignal.timeout(1000) }).then(async (response) => response.json() as Promise<{ "webSocketDebuggerUrl"?: string }>);

			if (version.webSocketDebuggerUrl === undefined || closed) {
				throw new Error("no DevTools socket");
			}

			const opened = new WebSocket(version.webSocketDebuggerUrl);

			await new Promise((resolve, reject) => {
				opened.addEventListener("open", resolve, { "once": true });
				opened.addEventListener("error", reject, { "once": true });
			});
			socket = opened;
			opened.addEventListener("message", ({ data }) => { onMessage(JSON.parse(String(data)) as Message); });
			opened.addEventListener("close", () => {
				socket = undefined;
				sessions.clear();
				retryAt = Date.now() + RETRY_MS;

				if (!closed) {
					say(`memory by realm: lost the browser's DevTools endpoint (${endpoint})`);
				}
			});
			say(`memory by realm: reading each linked tab's realms through the browser's DevTools endpoint (${endpoint})`);
		} catch {
			retryAt = Date.now() + RETRY_MS;
		} finally {
			connecting = false;
		}
	};

	const sample = async (): Promise<void> => {
		const tabs = linked();

		if (tabs.length === 0 || closed) {
			return;
		}

		if (socket === undefined) {
			if (!connecting && Date.now() >= retryAt) {
				await connect();
			}

			if (socket === undefined) {
				return;
			}
		}

		// The pages of the linked tabs, attached once each (and through them their workers and frames).
		const { result } = await send("Target.getTargets");
		const pages = ((result?.["targetInfos"] ?? []) as TargetInfo[]).filter((target) => target.type === "page");
		const attachedPages = new Set([...sessions.values()].filter(({ target }) => target.type === "page").map(({ target }) => target.targetId));

		for (const { tab, url } of tabs) {
			const page = pages.find((target) => samePage(target.url, url));

			if (page === undefined) {
				continue;
			}

			if (!attachedPages.has(page.targetId)) {
				attachedPages.add(page.targetId);
				await send("Target.attachToTarget", { "targetId": page.targetId, "flatten": true });

				continue; // (its workers attach as it does: read from the next sample)
			}

			const under = [...sessions].filter(([, attached]) => attached.page === page.targetId);
			const readings = await Promise.all(under.map(async ([sessionId, { target }]) => {
				const usage = (await send("Runtime.getHeapUsage", {}, sessionId)).result as { "usedSize"?: number; "backingStorageSize"?: number } | undefined;

				return usage?.usedSize === undefined ? undefined : { "target": target, "used": usage.usedSize, "backing": usage.backingStorageSize ?? 0 };
			}));
			const read = readings.filter((reading) => reading !== undefined);

			if (read.length > 0) {
				file(tab, sampleOf(read, Date.now()));
			}
		}
	};

	let running = false;
	const timer = setInterval(() => {
		if (!running) {
			running = true;
			void sample().finally(() => { running = false; });
		}
	}, everyMs);

	timer.unref();

	return {
		"via": () => (socket === undefined ? undefined : endpoint),
		"close": () => {
			closed = true;
			clearInterval(timer);
			socket?.close();
		}
	};
}
