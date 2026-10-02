/**
 * Naming an app's contexts where it joins another hub tree — the one naming rule: THE EDGE NAMES. Hub ids are the
 * app's own choice — every window of one app calls its page hub `page` — so where several apps' (or one app's several
 * windows') trees join a viewer's, their reports and records would land on the same ids and merge. The hub where an
 * app joins (the editor's shell, one link per preview window; netsim's referee, one per client) renames what comes
 * across, in every frame of observability traffic — architecture reports (the reporter, its topology, node ops and
 * traffic ends) on `$sys.arch.<id>`, log records on `$sys.log.<source>`, metrics samples on `$sys.metrics.<source>`, and
 * startup backlogs: the hub across the link
 * (its `peer`, the id its hello gave) IS the scope — `page` → `preview:5173` — and everything behind it moves under it
 * — `worker` → `preview:5173/worker`. Ids of the joining side (`keep` — the hub itself, which the app's reports name
 * as their uplink's peer) stay as they are. Nothing the app sends can pass as anything outside its scope.
 */
import type { Control, Envelope, Transport } from "@brianjenkins94/hub";
import type { ArchReport, NodeOp } from "./arch.ts";
import { mapFrame } from "@brianjenkins94/hub";
import { ARCH_SUBJECT } from "./arch.ts";
import { LOG_BACKLOG, LOG_SUBJECT } from "./index.ts";
import { METRICS_SUBJECT } from "./metrics.ts";

interface Frame { "subject"?: unknown; "data"?: unknown }
interface Record { "context"?: { "source"?: unknown } }

/** `id`, under `scope` (once — an id already under it is left alone). */
export function scopedId(scope: string, id: string): string {
	return id.startsWith(scope + "/") ? id : scope + "/" + id;
}

/** The scope an id sits under, if it's a scoped one (`<scope>/<id>`). */
export function scopeOf(id: string): string | undefined {
	const at = id.indexOf("/");

	return at > 0 ? id.slice(0, at) : undefined;
}

function scopeRecord(record: unknown, rename: (id: string) => string): unknown {
	const source = (record as Record | null)?.context?.source;

	return typeof source === "string" ? { ...(record as object), "context": { ...(record as Record).context, "source": rename(source) } } : record;
}

function scopeOp(op: NodeOp, rename: (id: string) => string): NodeOp {
	if ("spec" in op) {
		return { ...op, "spec": { ...op.spec, "id": rename(op.spec.id) } };
	}

	return { ...op, "id": rename(op.id) };
}

/** How the edge names one of an app's ids: its `peer` is the scope itself, anything else is under it. */
function renamer(scope: string, peer: string | undefined): (id: string) => string {
	return (id) => (id === peer ? scope : scopedId(scope, id));
}

/** `report`, its app's hub ids renamed under `scope` (`peer` — the hub across the link — to `scope` itself). The
 *  reporter is always the app's — even one that calls itself by a kept name (an app hub named `shell` must not pass as
 *  the editor's) — so it, and any id equal to it, is always renamed; `keep` spares only the OTHER ids it mentions (the
 *  joining side it links to). */
export function scopeArchReport(report: ArchReport, scope: string, keep: (id: string) => boolean = () => false, peer?: string): ArchReport {
	const named = renamer(scope, peer);
	const rename = (id: string): string => (id !== report.reporter && keep(id) ? id : named(id));

	return {
		...report,
		"reporter": rename(report.reporter),
		...report.topology === undefined ? {} : { "topology": { ...report.topology, "id": rename(report.topology.id), "links": report.topology.links.map((link) => (link.peerId === undefined ? link : { ...link, "peerId": rename(link.peerId) })) } },
		...report.nodes === undefined ? {} : { "nodes": report.nodes.map((op) => scopeOp(op, rename)) },
		...report.traffic === undefined ? {} : { "traffic": report.traffic.map((count) => ({ ...count, "from": rename(count.from), "to": rename(count.to) })) },
		...report.samples === undefined ? {} : { "samples": report.samples.map((sample) => ({ ...sample, "from": rename(sample.from), "to": rename(sample.to) })) }
	};
}

/**
 * One hub frame from an app, with its observability scoped (anything else — control frames, RPC, the app's own
 * traffic — as it came). Apply it where the app's frames arrive, before the hub sees them: `scopedTransport`.
 */
export function scopeObservability(frame: unknown, scope: string, keep: (id: string) => boolean = () => false, peer?: string): unknown {
	const subject = (frame as Frame | null)?.subject;

	// Only messages: a control frame's subject is interest (`sub $sys.arch.>`) — the app's wanting, not its saying.
	if (typeof subject !== "string" || "hub" in (frame as object)) {
		return frame;
	}

	const { data } = frame as Frame;

	// A record is always the app's (nothing of the joining side's comes from the app): renamed whatever its source.
	const always = renamer(scope, peer);

	if (subject.startsWith(ARCH_SUBJECT + ".") && subject !== ARCH_SUBJECT + ".sync") {
		if (typeof (data as ArchReport | null)?.reporter !== "string") {
			// Not a report a viewer can read — but under the scope all the same.
			return { ...(frame as object), "subject": ARCH_SUBJECT + "." + always(subject.slice(ARCH_SUBJECT.length + 1)) };
		}

		const report = scopeArchReport(data as ArchReport, scope, keep, peer);

		return { ...(frame as object), "subject": ARCH_SUBJECT + "." + report.reporter, "data": report };
	}

	if (subject.startsWith(LOG_SUBJECT + ".")) {
		return { ...(frame as object), "subject": LOG_SUBJECT + "." + always(subject.slice(LOG_SUBJECT.length + 1)), "data": scopeRecord(data, always) };
	}

	// A sample names its source twice — its subject, and its own `source` (what a monitor reads) — both under the scope.
	if (subject.startsWith(METRICS_SUBJECT + ".")) {
		const source = always(subject.slice(METRICS_SUBJECT.length + 1));
		const sample = data !== null && typeof data === "object" ? { ...(data as object), "source": source } : data;

		return { ...(frame as object), "subject": METRICS_SUBJECT + "." + source, "data": sample };
	}

	if (subject === LOG_BACKLOG && Array.isArray(data)) {
		return { ...(frame as object), "data": data.map((record) => scopeRecord(record, always)) };
	}

	return frame;
}

/**
 * `transport` — an app's link into this tree — with the observability of every frame arriving on it named by this edge
 * (scopeObservability): the hub across it — whose hello says its id — is `scope`, the rest under it. `keep` spares the
 * joining side's own ids (this hub's — what the app's reports name its uplink). `onFrame` sees each frame as renamed (to
 * note who reported, say).
 */
export function scopedTransport(transport: Transport, scope: string, { keep, onFrame }: { "keep"?: (id: string) => boolean; "onFrame"?: (frame: Envelope | Control) => void } = {}): Transport {
	let peer: string | undefined;

	return {
		...transport,
		"listen": (onMessage) => transport.listen((message) => {
			onMessage(mapFrame(message, (frame) => {
				// A hub's hello comes before anything it publishes: by then, the peer's own id is known.
				if ("hub" in frame && frame.hub === "hello" && typeof frame.id === "string") {
					peer = frame.id;
				}

				const scoped = scopeObservability(frame, scope, keep, peer) as typeof frame;

				onFrame?.(scoped);

				return scoped;
			}));
		})
	};
}
