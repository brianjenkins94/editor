// Shared, coordination-free node identity across a commit history — content-defined chunking applied to the COMMIT
// CHAIN (the idea from the Keyhive talk: "consistent chunking without coordination").
//
// The problem this solves: if two participants each seed identity from wherever they happen to be (A at C0, B at
// C1), they mint different ids for the same node — identity diverges on join point. The fix: don't seed from "where
// I am"; seed from a base that everyone picks DETERMINISTICALLY from content. A commit is a BOUNDARY iff a predicate
// over its (content-addressed) oid fires; walking back from HEAD to the nearest boundary lands every participant on
// the same base without coordination, without the whole history, and without persisting anything back to git. From
// that base we derive identity forward commit-by-commit (each step a pure `reidentify`), so the same base + same
// history ⇒ identical node ids.
//
// Two participants at DIFFERENT heads compare ids by anchoring at the most recent boundary in their COMMON ancestry
// (selectBase over the common-ancestor index) — the boundary they both possess. Knob N trades recompute depth for
// base stability; with no boundary back to the root, the root is the base (a short history is cheap anyway).
import type { ChangeKind, Snapshot } from "./identity";
import { nodeAtoms, reidentify } from "./identity";
import { cstSpansAsync } from "./spans";

/** A commit's contribution for one file: its oid and the file's content at that commit. */
export interface Commit {
	"oid": string;
	"content": string;
}

/** FNV-1a 32-bit over the oid — a cheap, deterministic hash every participant computes identically. */
function fnv32(text: string): number {
	let h = 0x811c9dc5;

	for (let index = 0; index < text.length; index += 1) {
		h ^= text.charCodeAt(index);
		h = Math.imul(h, 0x01000193) >>> 0;
	}

	return h >>> 0;
}

/** A commit is a content-defined boundary (~1 in `n`) purely from its oid — no coordination needed. */
export function isCommitBoundary(oid: string, n: number): boolean {
	return fnv32(oid) % n === 0;
}

/**
 * The base index to seed identity from: the most recent boundary at or before `headIndex`, else the root (0). Pure
 * function of the oids, so all participants agree.
 */
export function selectBase(oids: string[], headIndex: number, n: number): number {
	for (let index = headIndex; index > 0; index -= 1) {
		if (isCommitBoundary(oids[index], n)) {
			return index;
		}
	}

	return 0;
}

/** Derive the node identity snapshot at `headIndex` by seeding at `baseIndex` and re-identifying forward. */
export function deriveIdentity(commits: Commit[], baseIndex: number, headIndex: number, production = "Program"): Snapshot {
	let snapshot = reidentify(null, nodeAtoms(commits[baseIndex].content, production));

	for (let index = baseIndex + 1; index <= headIndex; index += 1) {
		snapshot = reidentify(snapshot, nodeAtoms(commits[index].content, production));
	}

	return snapshot;
}

/**
 * Identity at HEAD using the content-defined base: picks the base with {@link selectBase} and derives forward. Work is
 * bounded to base→HEAD, and the base is chosen from content so participants converge regardless of when they joined.
 */
export function headIdentity(commits: Commit[], headIndex: number, n: number, production = "Program"): { "snapshot": Snapshot; "baseIndex": number; "steps": number } {
	const baseIndex = selectBase(commits.map((commit) => commit.oid), headIndex, n);

	return { "snapshot": deriveIdentity(commits, baseIndex, headIndex, production), "baseIndex": baseIndex, "steps": headIndex - baseIndex };
}

function atomsEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((atom, index) => atom === b[index]);
}

interface Span { "type": string | null; "trivia": boolean; "token": boolean; "start": number; "end": number }

/** The non-trivia node atoms (aligned 1:1 with the non-trivia spans, in the same order the snapshot uses). */
function atomsFor(src: string, spans: Span[]): string[] {
	return spans.filter((span) => !span.trivia).map((span) => (span.type ?? "") + "\t" + (span.token ? JSON.stringify(src.slice(span.start, span.end)) : ""));
}

/** 1-based line number of a source offset. */
function lineAt(src: string, offset: number): number {
	let line = 1;

	for (let index = 0; index < offset && index < src.length; index += 1) {
		if (src[index] === "\n") {
			line += 1;
		}
	}

	return line;
}

/**
 * Yielding derive over an ALREADY-WINDOWED content chain (base first … HEAD … working last), for the classify worker.
 * The `contents` are what the caller pulled from real git history plus the working copy; this parses each (paced +
 * cancellable), re-identifies forward, and returns the final (working) snapshot with history-anchored ids, the
 * whole-file verdict from the last two contents (HEAD→working), and which working nodes are new/changed vs HEAD.
 */
export async function deriveIdentityAsync(contents: string[], options: { "signal"?: AbortSignal; "budget"?: number; "production"?: string } = {}): Promise<{ "verdict": ChangeKind | "none"; "changedNodeIds": string[]; "changedLines": number[]; "nodeLines": Record<string, number>; "snapshot": Snapshot | null }> {
	const production = options.production ?? "Program";

	try {
		if (contents.length === 0) {
			return { "verdict": "none", "changedNodeIds": [], "changedLines": [], "nodeLines": {}, "snapshot": { "nodes": [] } };
		}

		// Parse each link once (keeping spans so we can map changed nodes back to WORKING line numbers).
		const atomsChain: string[][] = [];
		let lastSpans: Span[] = [];

		for (const content of contents) {
			const spans = (await cstSpansAsync(content, production, options)).spans as Span[];

			lastSpans = spans;
			atomsChain.push(atomsFor(content, spans));
		}

		let snapshot = reidentify(null, atomsChain[0]);
		let previous = snapshot;

		for (let index = 1; index < atomsChain.length; index += 1) {
			previous = snapshot;
			snapshot = reidentify(snapshot, atomsChain[index]);
		}

		const verdict: ChangeKind | "none" = atomsChain.length < 2
			? "none"
			: (atomsEqual(atomsChain[atomsChain.length - 2], atomsChain[atomsChain.length - 1]) ? "cosmetic" : "semantic");
		const previousIds = new Set(previous.nodes.map((node) => node.id));
		const changed = atomsChain.length < 2
			? new Set(snapshot.nodes.map((node) => node.id))
			: new Set(snapshot.nodes.filter((node) => !previousIds.has(node.id)).map((node) => node.id));

		// Map each changed working node to its line: snapshot.nodes[i] aligns with the i-th non-trivia span of the
		// working content, so a changed node's span.start gives the line the reviewer should keep in focus.
		const workingContent = contents[contents.length - 1];
		const workingSpans = lastSpans.filter((span) => !span.trivia);
		const lineSet = new Set<number>();
		// EVERY working node's line (not just changed ones) — the annotation surface pins comments to node ids and needs
		// to resolve any id (changed or not) to its current line, and the reverse (a line → the node id on it).
		const nodeLines: Record<string, number> = {};

		snapshot.nodes.forEach((node, index) => {
			const span = workingSpans[index];

			if (span !== undefined) {
				const line = lineAt(workingContent, span.start);

				nodeLines[node.id] = line;

				if (changed.has(node.id)) {
					lineSet.add(line);
				}
			}
		});

		return { "verdict": verdict, "changedNodeIds": [...changed], "changedLines": [...lineSet].sort((a, b) => a - b), "nodeLines": nodeLines, "snapshot": snapshot };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}

		return { "verdict": "unparsable", "changedNodeIds": [], "changedLines": [], "nodeLines": {}, "snapshot": null };
	}
}

/** A human label + type for a changed node, derived from its atom (`type\t<jsonToken>`). */
function labelFor(atom: string): { "label": string; "kind": string } {
	const tab = atom.indexOf("\t");
	const kind = (tab === -1 ? atom : atom.slice(0, tab)) || "node";
	const token = tab === -1 ? "" : atom.slice(tab + 1);

	if (token !== "") {
		try {
			return { "label": JSON.parse(token) as string, "kind": kind };
		} catch { /* fall through to the type */ }
	}

	return { "label": kind, "kind": kind };
}

/** One node-grouped chunk for the changes-pane timeline: what changed, and the line range to highlight on hover.
 *  A chunk merges the changed CST nodes that share lines (so `const c = 3;` is one chunk, not six tokens). */
export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "nodeIds": string[] }

/** Merge per-node changes that overlap on a line into region-chunks; label each by its most meaningful token. */
function mergeGroups(nodes: { "id": string; "label": string; "kind": string; "startLine": number; "endLine": number }[]): EditGroup[] {
	const sorted = [...nodes].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	const clusters: { "startLine": number; "endLine": number; "members": typeof sorted }[] = [];

	for (const node of sorted) {
		const current = clusters[clusters.length - 1];

		if (current !== undefined && node.startLine <= current.endLine) {
			current.endLine = Math.max(current.endLine, node.endLine);
			current.members.push(node);
		} else {
			clusters.push({ "startLine": node.startLine, "endLine": node.endLine, "members": [node] });
		}
	}

	// Prefer an Identifier's name as the chunk label; else the longest word-like token; else the cluster's line span.
	const pick = (members: typeof sorted): { "label": string; "kind": string } => {
		const named = members.find((member) => member.kind === "Identifier" && /\w/u.test(member.label));
		const wordy = [...members].filter((member) => /^\w[\w$]*$/u.test(member.label)).sort((a, b) => b.label.length - a.label.length)[0];
		const chosen = named ?? wordy;

		return chosen !== undefined ? { "label": chosen.label, "kind": chosen.kind } : { "label": "", "kind": members[0]?.kind ?? "node" };
	};

	return clusters.map((cluster) => {
		const { label, kind } = pick(cluster.members);

		return { "label": label === "" ? "line " + cluster.startLine : label, "kind": kind, "startLine": cluster.startLine, "endLine": cluster.endLine, "nodeIds": cluster.members.map((member) => member.id) };
	});
}

/**
 * Decompose a change into node-grouped chunks for the "your edits" timeline. `contents` is the burst chain
 * [HEAD, …burst afters] (last = working); this re-identifies forward (so ids are stable across the bursts) and returns
 * the nodes that are NET new/changed HEAD→working, each with a display label and its current line range — the range the
 * pane highlights when the reviewer hovers the chunk. `bursts` is how many edit-bursts produced this change.
 */
export async function editGroups(contents: string[], options: { "signal"?: AbortSignal; "budget"?: number; "production"?: string } = {}): Promise<{ "groups": EditGroup[]; "bursts": number }> {
	const production = options.production ?? "Program";

	if (contents.length < 2) {
		return { "groups": [], "bursts": 0 };
	}

	try {
		const atomsChain: string[][] = [];
		let lastSpans: Span[] = [];

		for (const content of contents) {
			const spans = (await cstSpansAsync(content, production, options)).spans as Span[];

			lastSpans = spans;
			atomsChain.push(atomsFor(content, spans));
		}

		let snapshot = reidentify(null, atomsChain[0]);
		const headIds = new Set(snapshot.nodes.map((node) => node.id));

		for (let index = 1; index < atomsChain.length; index += 1) {
			snapshot = reidentify(snapshot, atomsChain[index]);
		}

		const working = contents[contents.length - 1];
		const workingSpans = lastSpans.filter((span) => !span.trivia);
		const changed: { "id": string; "label": string; "kind": string; "startLine": number; "endLine": number }[] = [];

		snapshot.nodes.forEach((node, index) => {
			const span = workingSpans[index];

			if (span !== undefined && !headIds.has(node.id)) {
				const { label, kind } = labelFor(node.atom);

				changed.push({ "id": node.id, "label": label, "kind": kind, "startLine": lineAt(working, span.start), "endLine": lineAt(working, span.end) });
			}
		});

		return { "groups": mergeGroups(changed), "bursts": contents.length - 1 };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}

		return { "groups": [], "bursts": contents.length - 1 };
	}
}
