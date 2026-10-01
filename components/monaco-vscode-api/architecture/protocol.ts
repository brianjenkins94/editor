/**
 * Shapes shared by the architecture probes of this component. The component doesn't depend on
 * @brianjenkins94/observability: `ArchSink` is structurally its sink, handed in by the consumer (the workbench).
 */
export type TrafficKind = "request" | "reply" | "error" | "event" | "message" | "ack" | "cancel" | "lifecycle";
export type NodeState = "declared" | "alive" | "unresponsive" | "terminated";

export interface ArchNodeSpec {
	"id": string;
	"role"?: string;
	"label"?: string;
	"container"?: string;
	"detail"?: string;
	"dynamic"?: boolean;
	"meta"?: Record<string, string>;
}

export interface ArchSink {
	readonly "self": string;
	"declare": (spec: ArchNodeSpec) => void;
	"spawn": (spec: ArchNodeSpec) => void;
	"terminate": (id: string) => void;
	"state": (id: string, state: NodeState) => void;
	"record": (from: string, to: string, kind: TrafficKind, label: string, bytes?: number, count?: number) => void;
}

/**
 * A probed worker posts a MessagePort as its very first message, then batches of `ProbeMessage` through it. The
 * port must be the message itself (not wrapped): the extension host iframe relays worker messages as transferables.
 */
export type ProbePeer = { "type": "worker"; "id": string } | { "type": "http"; "url": string };

export type ProbeMessage =
	| { "type": "hello"; "name": string }
	| { "type": "spawn"; "id": string; "name": string; "url": string }
	| { "type": "end"; "id": string }
	| { "type": "traffic"; "peer": ProbePeer; "outgoing": boolean; "kind": TrafficKind; "label": string; "bytes": number; "count"?: number };

export function approxSize(value: unknown, depth = 0): number {
	if (value === null || value === undefined) {
		return 0;
	}

	switch (typeof value) {
		case "string":
			return value.length;
		case "number":
		case "bigint":
			return 8;
		case "boolean":
			return 1;
		case "object":
			break;
		default:
			return 0;
	}

	if (value instanceof ArrayBuffer) {
		return value.byteLength;
	}

	if (ArrayBuffer.isView(value)) {
		return value.byteLength;
	}

	if (depth > 5) {
		return 0;
	}

	let size = 0;

	for (const item of Array.isArray(value) ? value : Object.values(value)) {
		size += approxSize(item, depth + 1);
	}

	return size;
}

/** JSON-RPC (LSP) / DAP / `{ type }` messages → kind + label. */
export function describeMessage(message: unknown): { "kind": TrafficKind; "label": string } {
	if (typeof message !== "object" || message === null) {
		return { "kind": "message", "label": typeof message };
	}

	if (Object.prototype.toString.call(message) === "[object MessagePort]") {
		return { "kind": "lifecycle", "label": "MessagePort" };
	}

	if (Object.prototype.toString.call(message) === "[object SharedArrayBuffer]") {
		return describeSyncApiRequest(message as SharedArrayBuffer);
	}

	const record = message as Record<string, unknown>;

	if (typeof record["method"] === "string") {
		return { "kind": record["id"] === undefined ? "event" : "request", "label": record["method"] };
	}

	if (record["jsonrpc"] !== undefined && record["id"] !== undefined) {
		return { "kind": record["error"] === undefined ? "reply" : "error", "label": "↩ #" + String(record["id"]) };
	}

	if (record["type"] === "request" && typeof record["command"] === "string") {
		return { "kind": "request", "label": record["command"] };
	}

	if (record["type"] === "response" && typeof record["command"] === "string") {
		return { "kind": record["success"] === false ? "error" : "reply", "label": "↩ " + record["command"] };
	}

	if (record["type"] === "event" && typeof record["event"] === "string") {
		return { "kind": "event", "label": record["event"] };
	}

	if (typeof record["type"] === "string") {
		return { "kind": "message", "label": record["type"] };
	}

	return { "kind": "message", "label": "message" };
}

const syncApiDecoder = new TextDecoder();

/**
 * A @vscode/sync-api request (tsserver's synchronous file system): the client posts the SharedArrayBuffer itself and
 * blocks on it (Atomics.wait) until the service writes the result in. Its header (32 bytes at offset 4) locates the
 * request's JSON — `{"id":…,"method":"fileSystem/stat",…}`.
 */
function describeSyncApiRequest(buffer: SharedArrayBuffer): { "kind": TrafficKind; "label": string } {
	try {
		const [offset, length] = new Uint32Array(buffer, 4, 2);
		const json = syncApiDecoder.decode(new Uint8Array(buffer, offset, length).slice());
		const method = /"method":"([^"]+)"/u.exec(json)?.[1];

		if (method !== undefined) {
			return { "kind": "request", "label": method };
		}
	} catch { /* not a sync-api request */ }

	return { "kind": "message", "label": "SharedArrayBuffer" };
}

export function isMessagePort(value: unknown): value is MessagePort {
	// Not instanceof: the port may come from another realm.
	return Object.prototype.toString.call(value) === "[object MessagePort]";
}

/** A `@brianjenkins94/hub` wire frame — counted by the hub's own tap, never twice by a probe. */
export function isHubFrame(data: unknown): boolean {
	return typeof data === "object" && data !== null && "\0hub" in data;
}
