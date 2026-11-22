import type { WorkspaceChange } from "../shared/workspace-changes";

export interface StatCache<Stat> {
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
