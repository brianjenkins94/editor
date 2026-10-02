/**
 * The tap in every page a preview serves (the dev server inlines it as the document's first script — node-worker.ts),
 * so it runs before the app's own code. It lights up what the editor can't otherwise see of an app — its console and
 * uncaught errors — keeps the app's new windows in the editor, gates the network the service worker can't see
 * (WebSocket, WebRTC), and tells the workers the page starts where they came from.
 *
 * A preview window's top frame holds its one hub into the editor: the tap's, linked to the shell (which names it as
 * the window — `preview:<port>`). Everything rides it: records on `$sys.log`, capability decisions and new windows as
 * calls the shell serves (`preview.decide`, `preview.open` — it knows the window from the link). The app's own hub, if
 * it has one, joins through it (`__editorTap.connect()`, used by observability's linkPreviewHost), never beside it.
 * A frame nested in the window — same origin — uses the top frame's tap directly.
 */
import type { Transport } from "@brianjenkins94/hub";
import type { TapRecord } from "./tap-shared";
import { createHub, createRpcClient, pipe, windowTransport } from "@brianjenkins94/hub";
import { createArchReporter, REALM_PARENT } from "@brianjenkins94/observability";
import { VIRTUAL_MARKER, VIRTUAL_RE, WINDOW_PARAM } from "../../virtual-path";
import { installConsoleTap, installSocketGate } from "./tap-shared";

/** What a preview window's top frame offers the frames in it and the app (`window.__editorTap`). */
export interface EditorTap {
	/** The preview window's id (`preview:<port>~<n>`). */
	"window": string;
	"log": (record: TapRecord) => void;
	"decide": (kind: string, resource: string) => Promise<boolean>;
	"open": (href: string) => void;
	/** A transport onto the window's hub, for the app's own hub to join the editor's tree through. */
	"connect": () => Transport;
}

type TapWindow = Window & { "__editorTap"?: EditorTap; "__obsTap"?: true };

/** The editor window hosting this preview: above every frame the app nests in it, each a preview page too — or, for a
 *  preview popped out into a browser window of its own, the editor that opened it. */
function findHost(): { "host": Window; "top": TapWindow } {
	let current: Window = window;

	try {
		while (current.parent !== current && current.parent.location.pathname.includes(VIRTUAL_MARKER)) {
			current = current.parent;
		}
	} catch { /* a parent we can't read: the top we have */ }

	const opener = current.parent === current ? (current.opener as Window | null) : null;

	return { "host": opener ?? current.parent, "top": current as TapWindow };
}

/** The top frame's tap: the window's hub, and what it offers. */
function windowTap(host: Window, windowId: string): EditorTap {
	const hub = createHub({ "id": "tap" });

	// Its uplink: the shell names it (the window), and the calls below are answered to that name.
	hub.link(windowTransport(host, location.origin), { "uplink": true });
	// The window's place in the editor's architecture: its realm, its links (the shell's, the app's), its traffic.
	createArchReporter(hub);

	const rpc = createRpcClient(hub);
	const log = (record: TapRecord): void => {
		hub.publish("$sys.log.tap", { "kind": "log", "level": record.level, "message": record.message, "attrs": record.attrs, "context": { "source": "tap" }, "time": Date.now(), "depth": 0 });
	};

	return {
		"window": windowId,
		"log": log,
		// Unanswered (no shell, no decider) ⇒ deny.
		"decide": async (kind, resource) => rpc.request("preview.decide", { "kind": kind, "resource": resource }, { "timeoutMs": 300_000, "waitForResponderMs": 10_000 }).then((allow) => allow === true, () => false),
		"open": (href) => { void rpc.request("preview.open", { "url": href }, { "timeoutMs": 10_000, "waitForResponderMs": 10_000 }).catch(() => undefined); },
		"connect": () => {
			const [mine, theirs] = pipe();

			hub.link(mine);

			return theirs;
		}
	};
}

function install(): void {
	const self = window as TapWindow;

	if (self.__obsTap === true) {
		return;
	}

	self.__obsTap = true;

	const { host, top } = findHost();
	const windowId = top.name;

	if (windowId === "") {
		return; // not a preview window the editor opened
	}

	if (top === self) {
		self.__editorTap = windowTap(host, windowId);
	}

	const tap = top.__editorTap;

	if (tap === undefined) {
		return;
	}

	// A nested frame's records name it (by its path on the server), on its window's hub.
	const frame = top === self ? undefined : "/" + location.pathname.split(VIRTUAL_MARKER)[1]!.split("/").slice(2).join("/");
	const send = (record: TapRecord): void => { tap.log(frame === undefined ? record : { ...record, "attrs": { "frame": frame, ...record.attrs } }); };

	installConsoleTap(send);
	installSocketGate(tap.decide);
	gateWebRtc(tap.decide);
	keepNewWindows(tap.open);
	tagWorkers(windowId);
}

/** New windows stay in the editor: the app opening one of its server's pages as a new window — `window.open`, a
 *  `target="_blank"` link, a modifier-click — gets another preview window onto that page, not a browser tab outside
 *  the editor. Anything else (another site, a named target) is the browser's, as always. There's no window to hand
 *  back, so such a `window.open` returns null (as a blocked popup does). */
function keepNewWindows(open: (href: string) => void): void {
	const pageOf = (url: unknown): string | undefined => {
		try {
			const parsed = new URL(String(url), location.href);

			return parsed.origin === location.origin && VIRTUAL_RE.test(parsed.pathname) ? parsed.href : undefined;
		} catch {
			return undefined;
		}
	};
	const original = window.open.bind(window);

	window.open = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
		const href = url === undefined || url === "" ? undefined : pageOf(url);

		if (href !== undefined && (target === undefined || target === "" || target === "_blank")) {
			open(href);

			return null;
		}

		return original(url, target, features);
	};
	addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0) {
			return;
		}

		const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;

		if (anchor === null || anchor.hasAttribute("download") || !(anchor.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey)) {
			return;
		}

		const href = pageOf(anchor.href);

		if (href !== undefined) {
			event.preventDefault();
			open(href);
		}
	});
}

/** WebRTC (peer-to-peer, past the service worker): a real peer connection, but with its ICE servers stripped until
 *  the decision allows them (closed if it denies). */
function gateWebRtc(decide: EditorTap["decide"]): void {
	const Original = window.RTCPeerConnection as typeof RTCPeerConnection | undefined;

	if (Original === undefined) {
		return;
	}

	const Gated = function(config: RTCConfiguration = {}): RTCPeerConnection {
		const urls = (config.iceServers ?? []).flatMap((server) => (typeof server.urls === "string" ? [server.urls] : server.urls));
		const connection = new Original({ ...config, "iceServers": [] });

		void decide("net.webrtc", urls.length > 0 ? urls.join(",") : "peer").then((allow) => {
			try {
				if (connection.signalingState === "closed") {
					return;
				}

				if (!allow) {
					connection.close();
				} else if (urls.length > 0) {
					connection.setConfiguration(config);
				}
			} catch { /* closed meanwhile */ }
		});

		return connection;
	} as unknown as typeof RTCPeerConnection;

	Gated.prototype = Original.prototype;
	(window as { "RTCPeerConnection": unknown }).RTCPeerConnection = Gated;
}

/** The workers this page starts are told where they came from — this page (their realm's parent) and its preview
 *  window — in their URL's hash, which never reaches the server. */
function tagWorkers(windowId: string): void {
	const Original = window.Worker as typeof Worker | undefined;

	if (Original === undefined) {
		return;
	}

	const tagged = (url: string | URL): string | URL => {
		try {
			const parsed = new URL(String(url), location.href);

			if (parsed.origin !== location.origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
				return url;
			}

			const params = new URLSearchParams(parsed.hash.slice(1));

			params.set(REALM_PARENT, location.href);
			params.set(WINDOW_PARAM, windowId);
			parsed.hash = params.toString();

			return parsed.href;
		} catch {
			return url;
		}
	};

	(window as { "Worker": unknown }).Worker = class extends Original {
		public constructor(url: string | URL, options?: WorkerOptions) {
			super(tagged(url), options);
		}
	};
}

install();
