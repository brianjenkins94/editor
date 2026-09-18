// Node identity for a file across edits, plus the "your edits" chunk grouping. Everything here is
// baseline→current reidentification over a content chain — NO commit-chain CDC.
//
// (History: this file used to implement content-defined chunking over the COMMIT CHAIN — isCommitBoundary/selectBase/
// headIdentity — to pick a coordination-free shared base without full history. It was removed: CDC solved cross-peer
// CONVERGENCE but not temporal DURABILITY — its oid-based base selection churned ids on rebase/force-push/base-jump
// (proven in packages/vscode/test/collab-identity.test.mjs). Annotations instead resolve via reidentify(baseline→
// current), which is content-derived and immune to oid rewrites. See [[collab-identity-durability]].)
import type { ChangeKind, Op, Snapshot } from "./identity";
import { lcsOps, reidentify } from "./identity";
import { cstSpansAsync } from "./spans";

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
 * Yielding derive over a content chain (oldest → newest), for the classify worker — in practice `[HEAD, working]`.
 * Parses each link (paced + cancellable), re-identifies forward, and returns the final (working) snapshot, the
 * whole-file verdict from the last two links (e.g. HEAD→working), which final nodes are new/changed vs the previous
 * link, and every final node's line. Ids are relative to the FIRST link (the baseline) — no commit-chain/CDC.
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
 *  A chunk merges the changed CST nodes that share lines (so `const c = 3;` is one chunk, not six tokens). `edits` is
 *  how many distinct edit-bursts touched this chunk's region (repeated in-place edits count each time). */
export interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

/**
 * Attribute each edit-burst to the FINAL lines it touched, so a chunk can show how many bursts shaped it. Works purely
 * at the line level: a burst's changed lines are mapped to final-content coordinates via LCS anchors — so an edit that
 * was later replaced in place (typed `x=1`, then `x=2`, then `x=3`) still attributes to the final line it lived on,
 * giving the intuitive "3 edits" rather than only counting the surviving node's single birth. Returns, per 1-based final
 * line, the set of burst indices that touched it.
 */
function burstAttribution(contents: string[]): Set<number>[] {
	const lineArrays = contents.map((content) => content.split("\n"));
	const finalLines = lineArrays[lineArrays.length - 1];
	const perLine: Set<number>[] = Array.from({ "length": finalLines.length + 1 }, () => new Set<number>());

	for (let step = 1; step < lineArrays.length; step += 1) {
		const prev = lineArrays[step - 1];
		const cur = lineArrays[step];

		// The lines this burst added/changed, in `cur` coords (a deletion attributes to the line it collapsed onto).
		const stepOps = lcsOps(prev, cur);
		const touchedCur = new Set<number>();

		stepOps.forEach((op, index) => {
			if (op.kind === "ins") {
				touchedCur.add(op.bi!);
			} else if (op.kind === "del") {
				const next = stepOps.slice(index).find((later) => later.bi !== undefined);

				touchedCur.add(next?.bi ?? Math.max(0, cur.length - 1));
			}
		});

		// Map `cur` lines to final lines by their surviving matches; anchors bracket the ones that don't survive.
		const curToFinal = new Map<number, number>();
		const matchedCur: number[] = [];

		for (const op of lcsOps(cur, finalLines) as Op[]) {
			if (op.kind === "eql") {
				curToFinal.set(op.ai!, op.bi!);
				matchedCur.push(op.ai!);
			}
		}

		for (const cursor of touchedCur) {
			const finalLinesHit = new Set<number>();

			if (curToFinal.has(cursor)) {
				finalLinesHit.add(curToFinal.get(cursor)! + 1); // survived unchanged → its own final line
			} else {
				// Replaced/deleted later: attribute the final lines that sit between the surrounding surviving anchors.
				let below = -1;
				let above = finalLines.length;

				for (const matched of matchedCur) {
					if (matched < cursor) {
						below = curToFinal.get(matched)!;
					} else {
						above = curToFinal.get(matched)!;
						break;
					}
				}

				if (below + 1 <= above - 1) {
					for (let line = below + 1; line <= above - 1; line += 1) {
						finalLinesHit.add(line + 1);
					}
				} else {
					const anchor = above < finalLines.length ? above : below;

					if (anchor >= 0 && anchor < finalLines.length) {
						finalLinesHit.add(anchor + 1);
					}
				}
			}

			for (const line of finalLinesHit) {
				if (line >= 1 && line <= finalLines.length) {
					perLine[line].add(step);
				}
			}
		}
	}

	return perLine;
}

/** Merge per-node changes that overlap on a line into region-chunks; label each by its most meaningful token. The
 *  per-chunk `edits` count is attached later (editGroups), once the whole burst chain is available for attribution. */
function mergeGroups(nodes: { "id": string; "label": string; "kind": string; "startLine": number; "endLine": number }[]): Omit<EditGroup, "edits">[] {
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
			// BABLR can't parse the empty string (it throws) — an empty file is simply zero nodes. This is the common
			// case for an ADDED file, whose HEAD side is "" (the timeline's base), so it must not abort the whole derive.
			if (content === "") {
				lastSpans = [];
				atomsChain.push([]);

				continue;
			}

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

		// Keep the INNERMOST changed nodes: drop any whose line range strictly contains another changed node's (a
		// container). Otherwise an added file — where every node incl. the root is "new" — collapses into one file-wide
		// blob; dropping containers leaves the real per-statement chunks.
		const minimal = changed.filter((node) => !changed.some((other) =>
			other !== node && other.startLine >= node.startLine && other.endLine <= node.endLine && (other.startLine > node.startLine || other.endLine < node.endLine)));

		// Attribute bursts to final lines, then count the distinct bursts each chunk's line range saw (≥1: it exists).
		const perLine = burstAttribution(contents);
		const groups: EditGroup[] = mergeGroups(minimal).map((group) => {
			const steps = new Set<number>();

			for (let line = group.startLine; line <= group.endLine; line += 1) {
				for (const step of perLine[line] ?? []) {
					steps.add(step);
				}
			}

			return { ...group, "edits": Math.max(1, steps.size) };
		});

		return { "groups": groups, "bursts": contents.length - 1 };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}

		return { "groups": [], "bursts": contents.length - 1 };
	}
}
