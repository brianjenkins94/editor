/**
 * Scoping an app's observability as it enters another hub tree. Hub ids are the app's own choice — every window of
 * one app calls its page hub `page` — so where several apps' (or one app's several windows') trees join a viewer's,
 * their reports and records would land on the same ids and merge. The hub where an app joins (the editor's shell, one
 * link per preview window) renames the app's side under a scope — `page` → `<scope>/page` — in every frame of
 * observability traffic that comes across: architecture reports (the reporter, its topology, node ops and traffic
 * ends) on `$sys.arch.<id>`, log records on `$sys.log.<source>`, and startup backlogs. Ids on the joining side (`keep`
 * — the shell, which the app's page links to) stay as they are; everything else of the app's moves under the scope.
 */
import type { Control, Envelope, Transport } from "@brianjenkins94/hub";
import type { ArchReport, NodeOp } from "./arch.ts";
import { mapFrame } from "@brianjenkins94/hub";
import { ARCH_SUBJECT } from "./arch.ts";
import { LOG_BACKLOG, LOG_SUBJECT } from "./index.ts";

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

/** `report`, its app's hub ids renamed under `scope`. The reporter is always the app's — even one that calls itself by
 *  a kept name (an app hub named `shell` must not pass as the editor's) — so it, and any id equal to it, is always
 *  scoped; `keep` spares only the OTHER ids it mentions (the joining side it links to). */
export function scopeArchReport(report: ArchReport, scope: string, keep: (id: string) => boolean = (id) => id === "shell"): ArchReport {
	const rename = (id: string): string => (id !== report.reporter && keep(id) ? id : scopedId(scope, id));

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
export function scopeObservability(frame: unknown, scope: string, keep: (id: string) => boolean = (id) => id === "shell"): unknown {
	const subject = (frame as Frame | null)?.subject;

	if (typeof subject !== "string") {
		return frame;
	}

	const { data } = frame as Frame;

	if (subject.startsWith(ARCH_SUBJECT + ".") && subject !== ARCH_SUBJECT + ".sync" && typeof data === "object" && data !== null) {
		const report = scopeArchReport(data as ArchReport, scope, keep);

		return { ...(frame as object), "subject": ARCH_SUBJECT + "." + report.reporter, "data": report };
	}

	// A record is always the app's (nothing of the joining side's comes from the app): scoped whatever its source.
	const always = (id: string): string => scopedId(scope, id);

	if (subject.startsWith(LOG_SUBJECT + ".")) {
		return { ...(frame as object), "subject": LOG_SUBJECT + "." + always(subject.slice(LOG_SUBJECT.length + 1)), "data": scopeRecord(data, always) };
	}

	if (subject === LOG_BACKLOG && Array.isArray(data)) {
		return { ...(frame as object), "data": data.map((record) => scopeRecord(record, always)) };
	}

	return frame;
}

/**
 * `transport` — an app's link into this tree — with the observability of every frame arriving on it scoped under
 * `scope` (scopeObservability). `onFrame` sees each frame as scoped (to note who reported, say).
 */
export function scopedTransport(transport: Transport, scope: string, { keep, onFrame }: { "keep"?: (id: string) => boolean; "onFrame"?: (frame: Envelope | Control) => void } = {}): Transport {
	return {
		...transport,
		"listen": (onMessage) => transport.listen((message) => {
			onMessage(mapFrame(message, (frame) => {
				const scoped = scopeObservability(frame, scope, keep) as typeof frame;

				onFrame?.(scoped);

				return scoped;
			}));
		})
	};
}
