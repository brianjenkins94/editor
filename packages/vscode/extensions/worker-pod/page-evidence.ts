/**
 * The page runtime of runtime evidence (RUNTIME-EVIDENCE.md, the third slice): what a preview's instrumented modules
 * (almostnode's frameworks/instrument.ts) tell `globalThis.__evidence`, counted in the page — statements as they start,
 * what went through each site — and reported to the editor through the page tap.
 *
 * Counts are page-global, by file and version (the module source's git blob oid): a module a hot update re-imports
 * with an edit counts into its new version, one re-imported unchanged counts on into its old one; a module's own scope
 * would lose them on every update. A report is a page's totals since it loaded, not what changed since the last, so a
 * lost one costs nothing. A page reports every 10 seconds while its counts change, on each hot update (before the
 * module is re-imported), on `pagehide`, and whenever the editor asks (`flush`).
 */
import type { ObserveSite } from "@brianjenkins94/tsval";
import type { SiteObservation, StatementCoverage } from "./debug-protocol";
import { typeTag } from "../../../tsval/src/values";

/** What one version of a module observed in a page: its file and version, each statement with its count, each site
 *  that ran — positions in the module's original source. */
export interface ModuleEvidence { "file": string; "version": string; "statements": StatementCoverage[]; "sites": SiteObservation[] }

/** What a site of a module records: a statement (coverage), or one of tsval's observe sites (instrument.ts). */
type SiteKind = "statement" | ObserveSite;

/** A site of the module's table: its kind and its node's range (0-based line and character). */
type Entry = [SiteKind, number, number, number, number];

/** The runtime operations an instrumented module calls (instrument.ts). */
interface Ops {
	"s": (site: number) => void;
	"v": (site: number, value: unknown) => unknown;
	"c": (site: number, before: number, value: unknown) => unknown;
	"b": (site: number, value: unknown) => unknown;
	"a": (site: number, value: unknown) => unknown;
	"o": (site: number, value: unknown) => unknown;
}

/** How often a page with changes reports. */
const REPORT_MS = 10_000;
/** At most this many type tags a site reports (the rest as `other`), and distinct primitives it keeps, each string cut
 *  to SAMPLE_CHARS — as the debug worker's site sums (site-sums.ts). */
const MAX_TAGS = 8;
const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 40;

/** A value site's kinds of value: the first it saw, counted on a fast path, then any others; and a few primitives. */
interface Kinds { "first": string; "firstCount": number; "others": Record<string, number> | undefined; "samples": (string | number | boolean)[] }

/** `tags`, at most MAX_TAGS of them: the most counted MAX_TAGS − 1, and the rest as `other`. */
function capped(tags: Record<string, number>): Record<string, number> {
	const ranked = Object.entries(tags).sort(([, a], [, b]) => b - a);

	return ranked.length <= MAX_TAGS ? tags : { ...Object.fromEntries(ranked.slice(0, MAX_TAGS - 1)), "other": ranked.slice(MAX_TAGS - 1).reduce((sum, [, count]) => sum + count, 0) };
}

/**
 * Count what the page's instrumented modules tell `globalThis.__evidence`, and call `report` with every version's
 * evidence when it's time. Returns `flush`, which reports now.
 */
export function installPageEvidence(report: (modules: ModuleEvidence[]) => void): { "flush": () => void } {
	const versions = new Map<string, { "file": string; "version": string; "table": Entry[]; "counts": Uint32Array; "seen": Uint32Array; "nullish": Uint32Array; "arms": Uint32Array; "kinds": (Kinds | undefined)[]; "ops": Ops }>();
	let changed = false;

	const module = (file: string, version: string, table: Entry[]): Ops => {
		const key = `${file}\0${version}`;
		const known = versions.get(key);

		if (known !== undefined) {
			return known.ops; // re-imported unchanged: it counts on
		}

		// Counted on the app's hot paths, so lean: typed counters by site, and each value site's kinds with a fast path
		// for the one it usually sees (most sites only ever see one).
		const counts = new Uint32Array(table.length);
		const seen = new Uint32Array(table.length);
		const nullish = new Uint32Array(table.length);
		const arms = new Uint32Array(table.length * 2);
		const kinds: (Kinds | undefined)[] = [];
		// Whether each optional link stopped its chain: a later link is told only when the one before it didn't.
		const stopped = new Uint8Array(table.length);
		const value = (site: number, observed: unknown): unknown => {
			changed = true;
			seen[site] += 1;

			if (observed === null || observed === undefined) {
				nullish[site] += 1;
				stopped[site] = 1;
			} else {
				stopped[site] = 0;
			}

			const tag = typeTag(observed);
			let mine = kinds[site];

			if (mine === undefined) {
				mine = { "first": tag, "firstCount": 0, "others": undefined, "samples": [] };
				kinds[site] = mine;
			}

			if (tag === mine.first) {
				mine.firstCount += 1;
			} else {
				mine.others ??= {};
				mine.others[tag] = (mine.others[tag] ?? 0) + 1;
			}

			if (mine.samples.length < MAX_SAMPLES) {
				const sample = typeof observed === "string" ? observed.slice(0, SAMPLE_CHARS) : typeof observed === "boolean" || (typeof observed === "number" && Number.isFinite(observed)) ? observed : undefined;

				if (sample !== undefined && !mine.samples.includes(sample)) {
					mine.samples.push(sample);
				}
			}

			return observed;
		};
		const ops: Ops = {
			"s": (site) => { counts[site] += 1; changed = true; },
			"v": value,
			"c": (site, before, observed) => {
				if (stopped[before] === 1) {
					stopped[site] = 1;

					return observed;
				}

				return value(site, observed);
			},
			"b": (site, observed) => { arms[site * 2 + (observed ? 0 : 1)] += 1; changed = true; return observed; },
			"a": (site, observed) => { arms[site * 2 + (observed ? 0 : 1)] += 1; changed = true; return observed; },
			"o": (site, observed) => { arms[site * 2 + (observed ? 1 : 0)] += 1; changed = true; return observed; }
		};

		versions.set(key, { "file": file, "version": version, "table": table, "counts": counts, "seen": seen, "nullish": nullish, "arms": arms, "kinds": kinds, "ops": ops });

		return ops;
	};

	const evidence = (): ModuleEvidence[] => [...versions.values()].map(({ file, version, table, counts, seen, nullish, arms, kinds }) => ({
		"file": file,
		"version": version,
		"statements": table.flatMap(([kind, ...range], site) => (kind === "statement" ? [{ "start": [range[0]!, range[1]!] as [number, number], "end": [range[2]!, range[3]!] as [number, number], "count": counts[site]! }] : [])),
		"sites": table.flatMap(([kind, ...range], site): SiteObservation[] => {
			const at = { "site": kind as ObserveSite, "start": [range[0]!, range[1]!] as [number, number], "end": [range[2]!, range[3]!] as [number, number] };

			if (kind === "branch") {
				const [taken, other] = [arms[site * 2] ?? 0, arms[site * 2 + 1] ?? 0];

				return taken + other === 0 ? [] : [{ ...at, "arms": [taken, other] }];
			}

			const mine = kinds[site];

			return kind === "statement" || mine === undefined ? [] : [{ ...at, "seen": seen[site]!, "nullish": nullish[site]!, "tags": capped({ [mine.first]: mine.firstCount, ...mine.others }), ...mine.samples.length > 0 ? { "samples": mine.samples } : {} }];
		})
	}));

	const flush = (): void => {
		if (versions.size > 0) {
			changed = false;
			report(evidence());
		}
	};

	// `module` is what instrumented modules call; `evidence` reads what the page has counted (for a debugger, a test).
	(globalThis as { "__evidence"?: { "module": typeof module; "evidence": typeof evidence } }).__evidence = { "module": module, "evidence": evidence };
	setInterval(() => {
		if (changed) {
			flush();
		}
	}, REPORT_MS);
	// A hot update re-imports a module: what its old version counted goes first. (The tap is the page's first script,
	// so this listener hears the update before the HMR client acts on it.)
	addEventListener("message", (event: MessageEvent) => {
		if ((event.data as { "channel"?: unknown } | null)?.channel === "vite-hmr") {
			flush();
		}
	});
	addEventListener("pagehide", flush);

	return { "flush": flush };
}
