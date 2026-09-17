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
import { nodeAtoms, nodeAtomsAsync, reidentify } from "./identity";

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

/**
 * Yielding derive over an ALREADY-WINDOWED content chain (base first … HEAD … working last), for the classify worker.
 * The `contents` are what the caller pulled from real git history plus the working copy; this parses each (paced +
 * cancellable), re-identifies forward, and returns the final (working) snapshot with history-anchored ids, the
 * whole-file verdict from the last two contents (HEAD→working), and which working nodes are new/changed vs HEAD.
 */
export async function deriveIdentityAsync(contents: string[], options: { "signal"?: AbortSignal; "budget"?: number; "production"?: string } = {}): Promise<{ "verdict": ChangeKind | "none"; "changedNodeIds": string[]; "snapshot": Snapshot | null }> {
	const production = options.production ?? "Program";

	try {
		if (contents.length === 0) {
			return { "verdict": "none", "changedNodeIds": [], "snapshot": { "nodes": [] } };
		}

		const atomsChain: string[][] = [];

		for (const content of contents) {
			atomsChain.push(await nodeAtomsAsync(content, production, options));
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
		const changedNodeIds = atomsChain.length < 2
			? snapshot.nodes.map((node) => node.id)
			: snapshot.nodes.filter((node) => !previousIds.has(node.id)).map((node) => node.id);

		return { "verdict": verdict, "changedNodeIds": changedNodeIds, "snapshot": snapshot };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}

		return { "verdict": "unparsable", "changedNodeIds": [], "snapshot": null };
	}
}
