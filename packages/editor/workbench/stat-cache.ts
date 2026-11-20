/**
 * What the workspace's file provider last found at each path (workspace-fs.ts's `stat`): its stat, or null for nothing
 * there. TypeScript's module resolution asks the same paths over and over as a project loads (16.7k stats in a cold load
 * of this repository, 2026-11-02), each a walk from the store's root. A path is forgotten as anything changes it, a folder
 * above it (its listing's mtime), or a folder it's in that goes or comes (renamed into place, its files asked for before).
 * Each folder's kept paths are indexed, a folder on the way among them, so forgetting what's under a path walks only what's
 * kept there: the store's watcher tells each write as it's made, a clone's thousands.
 */
import type { WorkspaceChange } from "../shared/workspace-changes";

export interface StatCache<Stat> {
	/** What's kept for `path`: its stat, null (nothing there), or undefined (not asked since it last changed). */
	"get": (path: string) => Stat | null | undefined;
	"remember": (path: string, stat: Stat | null) => void;
	"forget": (changes: readonly WorkspaceChange[]) => void;
	"size": () => number;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

export function statCache<Stat>(): StatCache<Stat> {
	const stats = new Map<string, Stat | null>();
	const under = new Map<string, Set<string>>();

	const forgetUnder = (path: string): void => {
		const kept = under.get(path);

		if (kept !== undefined) {
			under.delete(path);

			for (const child of kept) {
				stats.delete(child);
				forgetUnder(child);
			}
		}
	};

	return {
		"get": (path) => stats.get(path),
		"remember": (path, stat) => {
			stats.set(path, stat);

			for (let child = path, at = parentOf(path); at !== ""; child = at, at = parentOf(at)) {
				const kept = under.get(at) ?? new Set<string>();

				if (kept.has(child)) {
					break;
				}

				kept.add(child);
				under.set(at, kept);
			}
		},
		"forget": (changes) => {
			for (const { path, type } of changes) {
				for (let at = path; at !== ""; at = parentOf(at)) {
					stats.delete(at);
				}

				if (type !== "changed") {
					forgetUnder(path);
				}
			}
		},
		"size": () => stats.size
	};
}
