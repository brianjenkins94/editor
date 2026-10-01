/**
 * Architecture probes for the workbench realm — the channels monaco-vscode-api opens that no hub carries:
 * - every Worker created in this realm (the monaco editor workers — their request/reply protocol decoded — and,
 *   because the LocalProcess extension host shares this realm, the workers our extensions spawn);
 * - main thread ⇄ extension host RPC (every MainThread / ExtHost proxy call, by name), for every extension host;
 * - the web worker extension host's iframe handshake, and — through a probe loaded into that worker — the workers
 *   IT spawns (tsserver, language servers);
 * - webviews: their MessagePort protocol and resource loading through their service worker.
 *
 * These patch VSCode internals, so they must run from this bundle (the only copy of those classes) and be
 * installed before `boot()` creates anything. A debugging tool: re-check them after a monaco-vscode-api bump.
 */
import type { ArchSink, ProbeMessage, TrafficKind } from "./protocol";
import { ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";
import { ChannelClient } from "@codingame/monaco-vscode-api/vscode/vs/base/parts/ipc/common/ipc";
import { RPCProtocol } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/rpcProtocol";
import { ExtensionHostManager } from "@codingame/monaco-vscode-extensions-service-override/vscode/vs/workbench/services/extensions/common/extensionHostManager";
import { WebviewElement } from "@codingame/monaco-vscode-view-common-service-override/vscode/vs/workbench/contrib/webview/browser/webviewElement";
import { probeBootstrapUrl } from "./bootstrapUrl";
import { approxSize, describeMessage, isHubFrame, isMessagePort } from "./protocol";

/** How a Worker created in this realm is shown — the app's own workers (a hub-carrying worker keeps its hub id). */
export interface WorkerIdentity {
	"id": string;
	"label"?: string;
	"role"?: string;
	"container"?: string;
	/** The node that talks to it, when not this realm's hub — e.g. a worker the pod (an extension, sharing this
	 *  realm) spawns. */
	"owner"?: string;
}

export interface MonacoProbeOptions {
	/** Identify a non-monaco worker from its url/options (default: `worker:<file name>`). */
	"identifyWorker"?: (url: string, options?: WorkerOptions) => WorkerIdentity | undefined;
	/** The node a nested worker's request goes to (default: `net:origin` / `net:<host>`) — e.g. the service worker, when
	 *  it controls this page (and so the workers it spawns). */
	"classifyUrl"?: (url: URL) => string;
}

export const EXT_HOST_IFRAME = "exthost-iframe";
export const WEBVIEW_SERVICE_WORKER = "webview-sw";

/** The worker labels VSCode asks MonacoEnvironment for, plus the timer service's one-shot blob worker. */
const MONACO_WORKERS: Record<string, string> = {
	"editorWorkerService": "Editor worker",
	"TextMateWorker": "TextMate worker",
	"OutputLinkDetectionWorker": "Output link worker",
	"LanguageDetectionWorker": "Language detection worker",
	"NotebookEditorWorker": "Notebook worker",
	"LocalFileSearchWorker": "Local file search worker",
	"perfBaseline": "Perf baseline worker"
};

export function monacoWorkerId(label: string): string {
	return "worker:" + label;
}

export function extensionHostId(kind: ExtensionHostKind, affinity = 0): string {
	return "exthost:" + ExtensionHostKind[kind] + ":" + affinity;
}

function fileName(url: string): string {
	return url.split(/[?#]/u)[0].split("/").pop() ?? url;
}

// ── nested probes (workers reporting through a MessagePort) ──────────────────────────────────────────────────

// Set once by installMonacoProbes: where a nested worker's request goes (see MonacoProbeOptions.classifyUrl).
let classifyChildUrl: ((url: URL) => string) | undefined;

function attachChildProbe(sink: ArchSink, port: MessagePort, ownerId: string, container: string): void {
	const nested = new Map<string, string>();

	port.onmessage = (event: MessageEvent<ProbeMessage[]>) => {
		for (const message of event.data) {
			switch (message.type) {
				case "spawn": {
					const id = "nested:" + message.name;

					nested.set(message.id, id);
					sink.spawn({ "id": id, "role": "nestedWorker", "label": message.name, "container": container, "detail": "spawned by " + ownerId, "dynamic": true, "meta": { "url": message.url } });
					break;
				}

				case "end": {
					const id = nested.get(message.id);

					if (id !== undefined) {
						sink.terminate(id);
					}

					break;
				}

				case "traffic": {
					let peer: string;
					let { label } = message;

					if (message.peer.type === "worker") {
						peer = nested.get(message.peer.id) ?? "nested:?";
					} else {
						const url = new URL(message.peer.url, location.href);

						peer = classifyChildUrl?.(url) ?? (url.origin === location.origin ? "net:origin" : "net:" + url.host);
						label = message.label + " " + fileName(url.pathname);
					}

					if (message.outgoing) {
						sink.record(ownerId, peer, message.kind, label, message.bytes, message.count);
					} else {
						sink.record(peer, ownerId, message.kind, label, message.bytes, message.count);
					}

					break;
				}

				// The worker's own URL, on its node — so a measurement that attributes memory by URL can name it.
				case "hello":
					if (message.url !== undefined) {
						sink.spawn({ "id": ownerId, "meta": { "url": message.url } });
					}

					break;

				default:
					break;
			}
		}
	};
}

// ── workers created in this realm ─────────────────────────────────────────────────────────────────────────────

/** Worker labels loaded through the probe bootstrap: their first message is the probe's port. */
const probedLabels = new Set<string>();

interface WorkerProtocolMessage {
	"vsWorker": number;
	"type": 0 | 1 | 2 | 3 | 4;
	"req"?: number | string;
	"seq"?: number | string;
	"channel"?: string;
	"method"?: string;
	"eventName"?: string;
	"args"?: unknown;
	"arg"?: unknown;
	"res"?: unknown;
	"err"?: unknown;
	"event"?: unknown;
}

function isWorkerProtocolMessage(data: unknown): data is WorkerProtocolMessage {
	return typeof data === "object" && data !== null && typeof (data as { "vsWorker"?: unknown }).vsWorker === "number";
}

/** Decodes vs/base/common/worker/webWorker: main → worker service calls, worker → main host calls, events. */
function monacoWorkerDecoder(): (data: unknown, outgoing: boolean) => { "kind": TrafficKind; "label": string; "bytes": number } {
	const outgoingRequests = new Map<unknown, string>();
	const incomingRequests = new Map<unknown, string>();
	const subscriptions = new Map<unknown, string>();

	return (data, outgoing) => {
		if (typeof data === "string") {
			return { "kind": "lifecycle", "label": data, "bytes": 0 };
		}

		if (!isWorkerProtocolMessage(data)) {
			if ((data as { "type"?: unknown } | undefined)?.type === "vscode-worker-ready") {
				return { "kind": "lifecycle", "label": "ready", "bytes": 0 };
			}

			return { ...describeMessage(data), "bytes": approxSize(data) };
		}

		switch (data.type) {
			case 0: {
				const method = data.channel === "default" ? data.method : data.channel + "." + data.method;

				(outgoing ? outgoingRequests : incomingRequests).set(data.req, method);

				return { "kind": "request", "label": method, "bytes": approxSize(data.args) };
			}

			case 1: {
				const requests = outgoing ? incomingRequests : outgoingRequests;
				const method = requests.get(data.seq) ?? "?";

				requests.delete(data.seq);

				return { "kind": data.err === undefined || data.err === null ? "reply" : "error", "label": "↩ " + method, "bytes": approxSize(data.res) };
			}

			case 2: {
				const name = data.channel + "." + data.eventName;

				subscriptions.set(data.req, name);

				return { "kind": "request", "label": "subscribe " + name, "bytes": 0 };
			}

			case 3:
				return { "kind": "event", "label": subscriptions.get(data.req) ?? "event", "bytes": approxSize(data.event) };
			default: {
				const name = subscriptions.get(data.req) ?? "";

				subscriptions.delete(data.req);

				return { "kind": "cancel", "label": "unsubscribe " + name, "bytes": 0 };
			}
		}
	};
}

function installWorkerProbe(sink: ArchSink, options: MonacoProbeOptions): void {
	globalThis.Worker = new Proxy(globalThis.Worker, {
		"construct": function(target, args: [string | URL, WorkerOptions?], newTarget) {
			const worker = Reflect.construct(target, args, newTarget) as Worker;

			try {
				instrumentWorker(sink, worker, String(args[0]), args[1], options);
			} catch { /* never break a worker */ }

			return worker;
		}
	});
}

function instrumentWorker(sink: ArchSink, worker: Worker, url: string, workerOptions: WorkerOptions | undefined, options: MonacoProbeOptions): void {
	const label = workerOptions?.name;
	const isMonaco = label !== undefined && label in MONACO_WORKERS;
	const identity: WorkerIdentity = isMonaco
		? { "id": monacoWorkerId(label), "label": MONACO_WORKERS[label], "role": "editorWorker", "container": "editorWorkers" }
		: options.identifyWorker?.(url, workerOptions) ?? { "id": "worker:" + fileName(url), "role": "worker", "container": "workers" };
	const { id } = identity;
	const decode = isMonaco ? monacoWorkerDecoder() : (data: unknown) => ({ ...describeMessage(data), "bytes": approxSize(data) });
	const owner = identity.owner ?? sink.self;

	sink.spawn({ "id": id, "role": identity.role, "label": identity.label, "container": identity.container, "detail": label ?? fileName(url), "meta": { "url": url } });

	const onMessage = (data: unknown, outgoing: boolean): void => {
		// A worker carrying a hub reports its hub traffic itself.
		if (isHubFrame(data)) {
			return;
		}

		const { kind, "label": messageLabel, bytes } = decode(data, outgoing);

		if (outgoing) {
			sink.record(owner, id, kind, messageLabel, bytes);
		} else {
			sink.record(id, owner, kind, messageLabel, bytes);
		}
	};

	let first = true;

	// Registered in the constructor: runs before any `onmessage` VSCode (or anyone) sets later.
	worker.addEventListener("message", (event) => {
		const expectProbe = first && label !== undefined && probedLabels.has(label);

		first = false;

		if (expectProbe && isMessagePort(event.data)) {
			event.stopImmediatePropagation(); // the worker's owner never sees it
			attachChildProbe(sink, event.data, id, identity.container ?? "workers");

			return;
		}

		onMessage(event.data, false);
	});
	worker.addEventListener("error", () => { sink.record(id, owner, "error", "worker error"); });

	const postMessage = worker.postMessage.bind(worker) as (message: unknown, transfer?: unknown) => void;

	worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void => {
		onMessage(message, true);
		postMessage(message, transfer);
	};

	const terminate = worker.terminate.bind(worker);

	worker.terminate = () => {
		sink.terminate(id);
		terminate();
	};
}

/** Load monaco's workers through the probe bootstrap, so a probe runs inside them. */
function wrapWorkerUrls(): void {
	const environment = window.MonacoEnvironment;
	const getWorkerUrl = environment?.getWorkerUrl;

	if (environment === undefined || getWorkerUrl === undefined) {
		return;
	}

	environment.getWorkerUrl = function(moduleId, label) {
		const url = getWorkerUrl.call(this, moduleId, label);

		if (url === undefined) {
			return url;
		}

		probedLabels.add(label);

		return probeBootstrapUrl + "#target=" + encodeURIComponent(url);
	};
}

// ── extension hosts (RPCProtocol) ─────────────────────────────────────────────────────────────────────────────

type RpcLogger = NonNullable<ConstructorParameters<typeof RPCProtocol>[1]>;

interface ExtensionHostManagerInternals {
	"kind": ExtensionHostKind;
	"onDidExit": (listener: () => void) => unknown;
	"onDidChangeResponsiveState": (listener: (state: number) => void) => unknown;
	"_extensionHost": { "runningLocation": { "affinity": number } };
	"_createExtensionHostCustomers": (kind: ExtensionHostKind, protocol: unknown) => unknown;
}

function createRpcLogger(sink: ArchSink, manager: ExtensionHostManagerInternals): RpcLogger {
	const id = extensionHostId(manager.kind, manager._extensionHost.runningLocation.affinity);

	sink.spawn({
		"id": id,
		"role": "extHost:" + ExtensionHostKind[manager.kind],
		"container": manager.kind === ExtensionHostKind.LocalWebWorker ? "extHostWorker" : manager.kind === ExtensionHostKind.Remote ? "remote" : "workbench"
	});
	manager.onDidExit(() => {
		sink.terminate(id);

		if (manager.kind === ExtensionHostKind.LocalWebWorker) {
			sink.terminate(EXT_HOST_IFRAME);
		}
	});
	manager.onDidChangeResponsiveState((state) => { sink.state(id, state === 0 ? "alive" : "unresponsive"); });

	// Requests initiated by each side, to name the replies.
	const mainRequests = new Map<number, string>();
	const hostRequests = new Map<number, string>();

	const log = (outgoing: boolean, msgLength: number, req: number, initiator: number, str: string): void => {
		let kind: TrafficKind;
		let label: string;
		// initiator 0 = LocalSide (the main thread), 1 = OtherSide (the extension host)
		const requests = initiator === 0 ? mainRequests : hostRequests;

		if (str.startsWith("request: ") || str.startsWith("receiveRequest ")) {
			kind = "request";
			label = str.slice(str.indexOf(" ") + 1, -1);
			requests.set(req, label);
		} else {
			const method = requests.get(req) ?? "#" + req;

			if (str === "ack") {
				kind = "ack";
				label = "ack " + method;
			} else {
				kind = str.includes("Err") ? "error" : str.toLowerCase().includes("cancel") ? "cancel" : "reply";
				label = "↩ " + method;
				requests.delete(req);
			}
		}

		if (outgoing) {
			sink.record(sink.self, id, kind, label, msgLength);
		} else {
			sink.record(id, sink.self, kind, label, msgLength);
		}
	};

	return {
		"logOutgoing": (msgLength, req, initiator, str) => { log(true, msgLength, req, initiator, str); },
		"logIncoming": (msgLength, req, initiator, str) => { log(false, msgLength, req, initiator, str); }
	};
}

function installExtensionHostProbe(sink: ArchSink): void {
	// The RPCProtocol is created inside `_createExtensionHostCustomers`: remember whose.
	let creating: ExtensionHostManagerInternals | undefined;
	const managerPrototype = ExtensionHostManager.prototype as unknown as ExtensionHostManagerInternals;
	const createCustomers = managerPrototype._createExtensionHostCustomers;
	const whileCreating = <T>(manager: ExtensionHostManagerInternals, fn: () => T): T => {
		creating = manager;

		try {
			return fn();
		} finally {
			creating = undefined;
		}
	};

	managerPrototype._createExtensionHostCustomers = function(this: ExtensionHostManagerInternals, ...args) {
		return whileCreating(this, () => createCustomers.apply(this, args));
	};

	// The RPCProtocol constructor does `this._logger = logger`: an accessor plugs ours in from the first message.
	// (The local extension host's OWN side is an RPCProtocol too, but created elsewhere — `creating` is unset.)
	const original = Symbol("originalLogger");
	const probe = Symbol("probeLogger");

	interface Internals { [original]?: RpcLogger | null; [probe]?: RpcLogger }

	Object.defineProperty(RPCProtocol.prototype, "_logger", {
		"configurable": true,
		"get": function(this: Internals) {
			return this[probe] ?? this[original] ?? null;
		},
		"set": function(this: Internals, logger: RpcLogger | null) {
			this[original] = logger;

			if (creating !== undefined) {
				const ours = createRpcLogger(sink, creating);

				this[probe] = logger === null
					? ours
					: {
							"logIncoming": (...args) => { logger.logIncoming(...args); ours.logIncoming(...args); },
							"logOutgoing": (...args) => { logger.logOutgoing(...args); ours.logOutgoing(...args); }
						};
			}
		}
	});
}

// ── remote agent IPC (unused today; costs nothing when there's no remote) ─────────────────────────────────────

function installIpcProbe(sink: ArchSink): void {
	interface Request { "type": number; "id": number; "channelName"?: string; "name"?: string; "arg"?: unknown }
	interface Response { "type": number; "id": number; "data"?: unknown }
	interface Internals { "sendRequest": (request: Request) => void; "onResponse": (response: Response) => void }

	const names = new WeakMap<object, Map<number, string>>();
	const namesOf = (client: object): Map<number, string> => {
		let map = names.get(client);

		if (map === undefined) {
			map = new Map();
			names.set(client, map);
		}

		return map;
	};

	const prototype = ChannelClient.prototype as unknown as Internals;
	const { sendRequest, onResponse } = prototype;

	prototype.sendRequest = function(this: Internals, request) {
		if (request.type === 100 || request.type === 102) {
			const label = request.channelName + "." + request.name;

			namesOf(this).set(request.id, label);
			sink.record(sink.self, "remote:management", "request", request.type === 102 ? "listen " + label : label, approxSize(request.arg));
		}

		sendRequest.call(this, request);
	};

	prototype.onResponse = function(this: Internals, response) {
		const label = namesOf(this).get(response.id) ?? "#" + response.id;

		if (response.type >= 201 && response.type <= 204) {
			sink.record("remote:management", sink.self, response.type === 201 ? "reply" : response.type === 204 ? "event" : "error", response.type === 204 ? label : "↩ " + label, approxSize(response.data));
		}

		onResponse.call(this, response);
	};
}

// ── webviews and the extension host iframe (window messages) ──────────────────────────────────────────────────

interface WebviewInfo { "label": string; "detail"?: string; "extension"?: string }

const webviewInfos = new Map<string, WebviewInfo>();
const listenedWindows = new WeakSet<Window>();
// The extension host iframe relays its worker's messages: the FIRST port is the probe's, the second VSCode's.
const extHostIframes = new Set<string>();
const extHostIframesWithProbe = new Set<string>();

function recordWebviewMessage(sink: ArchSink, id: string, channel: string, payload: unknown, outgoing: boolean): void {
	const data = (payload ?? {}) as { "path"?: string; "status"?: number; "message"?: unknown };
	const toWorkbench = (kind: TrafficKind, label: string, bytes = 0): void => {
		if (outgoing) {
			sink.record(sink.self, id, kind, label, bytes);
		} else {
			sink.record(id, sink.self, kind, label, bytes);
		}
	};

	switch (channel) {
		case "load-resource":
		case "load-localhost": {
			const label = channel + " " + (data.path?.split("/").pop() ?? "");

			sink.record(WEBVIEW_SERVICE_WORKER, id, "request", label);
			toWorkbench("request", label);
			break;
		}

		case "did-load-resource":
		case "did-load-localhost": {
			const label = channel + " " + (data.status ?? "") + " " + (data.path?.split("/").pop() ?? "");
			const kind: TrafficKind = data.status !== undefined && data.status >= 400 ? "error" : "reply";

			toWorkbench(kind, label);
			sink.record(id, WEBVIEW_SERVICE_WORKER, kind, label);
			break;
		}

		case "message":
			toWorkbench("message", "message → content", approxSize(data.message ?? payload));
			break;
		case "onmessage":
			toWorkbench("message", "onmessage ← content", approxSize(data.message ?? payload));
			break;
		case "fatal-error":
			toWorkbench("error", channel);
			break;
		default:
			toWorkbench("message", channel ?? "message", approxSize(payload));
	}
}

function instrumentWebview(sink: ArchSink, webviewId: string, port: MessagePort): void {
	const id = "webview:" + webviewId;
	const info = webviewInfos.get(webviewId);

	sink.spawn({ "id": id, "role": "webview", "label": info?.label ?? "Webview", "container": "webviews", "detail": info?.detail, "dynamic": true, "meta": info?.extension === undefined ? undefined : { "extension": info.extension } });
	sink.record(id, sink.self, "lifecycle", "webview-ready (MessagePort)");

	port.addEventListener("message", (event: MessageEvent<{ "channel": string; "data": unknown }>) => {
		recordWebviewMessage(sink, id, event.data.channel, event.data.data, false);
	});

	const postMessage = port.postMessage.bind(port) as (message: unknown, transfer?: unknown) => void;

	port.postMessage = (message: { "channel": string; "args": unknown }, transfer?: Transferable[] | StructuredSerializeOptions): void => {
		recordWebviewMessage(sink, id, message.channel, message.args, true);
		postMessage(message, transfer);
	};
}

function onWindowMessage(sink: ArchSink, event: MessageEvent): void {
	const data = event.data as Record<string, unknown> | null;

	if (data === null || typeof data !== "object") {
		return;
	}

	const iframeId = data["vscodeWebWorkerExtHostId"];

	if (typeof iframeId === "string") {
		if (!extHostIframes.has(iframeId)) {
			extHostIframes.add(iframeId);
			sink.spawn({ "id": EXT_HOST_IFRAME, "role": "extHostIframe", "container": "extHostIframe" });
		}

		if (data["type"] === "vscode.bootstrap.nls") {
			sink.record(EXT_HOST_IFRAME, sink.self, "request", "vscode.bootstrap.nls");
			// posted to the iframe's window — not interceptable
			sink.record(sink.self, EXT_HOST_IFRAME, "reply", "↩ vscode.bootstrap.nls (worker url, NLS)");
		} else if (data["error"] !== undefined) {
			sink.record(EXT_HOST_IFRAME, sink.self, "error", "extension host error");
		} else if (isMessagePort(data["data"])) {
			if (probedLabels.has("extensionHostWorkerMain") && !extHostIframesWithProbe.has(iframeId)) {
				extHostIframesWithProbe.add(iframeId);
				event.stopImmediatePropagation(); // VSCode expects exactly one port
				attachChildProbe(sink, data["data"], extensionHostId(ExtensionHostKind.LocalWebWorker), "extHostWorker");
				sink.record(EXT_HOST_IFRAME, sink.self, "lifecycle", "probe MessagePort (architecture)");
			} else {
				sink.record(EXT_HOST_IFRAME, sink.self, "lifecycle", "RPC MessagePort handoff");
				sink.record(sink.self, EXT_HOST_IFRAME, "lifecycle", "vscode.init (inferred)");
			}
		}

		return;
	}

	if (data["channel"] === "webview-ready" && typeof data["target"] === "string" && event.ports[0] !== undefined) {
		instrumentWebview(sink, data["target"], event.ports[0]);
	}
}

function listenWindowMessages(sink: ArchSink, target: Window): void {
	if (listenedWindows.has(target)) {
		return;
	}

	listenedWindows.add(target);
	// Capture phase: before VSCode's own listeners.
	target.addEventListener("message", (event) => { onWindowMessage(sink, event); }, true);
}

function installWebviewProbe(sink: ArchSink): void {
	interface Internals {
		"id": string;
		"providedViewType"?: string;
		"extension"?: { "id"?: { "value": string } };
		"_options"?: { "purpose"?: string };
		"mountTo": (element: HTMLElement, targetWindow: Window) => void;
		"dispose": () => void;
	}

	const prototype = WebviewElement.prototype as unknown as Internals;
	const { mountTo, dispose } = prototype;

	prototype.mountTo = function(this: Internals, element, targetWindow) {
		const extension = this.extension?.id?.value;

		webviewInfos.set(this.id, {
			"label": this.providedViewType ?? this._options?.purpose ?? extension ?? "Webview",
			"detail": [this._options?.purpose, extension].filter((part) => part !== undefined).join(" · "),
			"extension": extension
		});
		listenWindowMessages(sink, targetWindow); // auxiliary windows too

		mountTo.call(this, element, targetWindow);
	};

	prototype.dispose = function(this: Internals) {
		sink.terminate("webview:" + this.id);

		dispose.call(this);
	};

	listenWindowMessages(sink, window);
}

let installed = false;

/** Install every probe of this bundle. Call once, before `boot()`. */
export function installMonacoProbes(sink: ArchSink, options: MonacoProbeOptions = {}): void {
	if (installed) {
		return;
	}

	installed = true;
	classifyChildUrl = options.classifyUrl;

	for (const [label, name] of Object.entries(MONACO_WORKERS)) {
		// Only the workers this build can actually start (the timer service's blob worker always can).
		if (label !== "perfBaseline" && window.MonacoEnvironment?.getWorkerUrl?.("", label) === undefined) {
			continue;
		}

		sink.declare({ "id": monacoWorkerId(label), "role": "editorWorker", "label": name, "container": "editorWorkers", "detail": label });
	}

	wrapWorkerUrls();
	installWorkerProbe(sink, options);
	installExtensionHostProbe(sink);
	installIpcProbe(sink);
	installWebviewProbe(sink);
}
