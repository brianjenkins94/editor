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
import type { SiteSums } from "./site-sums";
import { addObservation, summary } from "./site-sums";

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

/**
 * Count what the page's instrumented modules tell `globalThis.__evidence`, and call `report` with every version's
 * evidence when it's time. Returns `flush`, which reports now.
 */
export function installPageEvidence(report: (modules: ModuleEvidence[]) => void): { "flush": () => void } {
	const versions = new Map<string, { "file": string; "version": string; "table": Entry[]; "counts": Uint32Array; "sums": SiteSums<number>; "ops": Ops }>();
	let changed = false;

	const module = (file: string, version: string, table: Entry[]): Ops => {
		const key = `${file}\0${version}`;
		const known = versions.get(key);

		if (known !== undefined) {
			return known.ops; // re-imported unchanged: it counts on
		}

		const counts = new Uint32Array(table.length);
		const sums: SiteSums<number> = new Map();
		// Whether each optional link stopped its chain: a later link is told only when the one before it didn't.
		const stopped = new Map<number, boolean>();
		const value = (site: number, observed: unknown): unknown => {
			stopped.set(site, observed === null || observed === undefined);
			addObservation(sums, site, table[site]![0] as Exclude<SiteKind, "statement">, observed);
			changed = true;

			return observed;
		};
		const arm = (site: number, taken: number): void => {
			addObservation(sums, site, "branch", taken);
			changed = true;
		};
		const ops: Ops = {
			"s": (site) => { counts[site] += 1; changed = true; },
			"v": value,
			"c": (site, before, observed) => {
				if (stopped.get(before) === true) {
					stopped.set(site, true);

					return observed;
				}

				return value(site, observed);
			},
			"b": (site, observed) => { arm(site, observed ? 0 : 1); return observed; },
			"a": (site, observed) => { arm(site, observed ? 0 : 1); return observed; },
			"o": (site, observed) => { arm(site, observed ? 1 : 0); return observed; }
		};

		versions.set(key, { "file": file, "version": version, "table": table, "counts": counts, "sums": sums, "ops": ops });

		return ops;
	};

	const evidence = (): ModuleEvidence[] => [...versions.values()].map(({ file, version, table, counts, sums }) => ({
		"file": file,
		"version": version,
		"statements": table.flatMap(([kind, ...range], site) => (kind === "statement" ? [{ "start": [range[0]!, range[1]!] as [number, number], "end": [range[2]!, range[3]!] as [number, number], "count": counts[site]! }] : [])),
		"sites": [...sums].map(([site, known]) => ({ "start": [table[site]![1], table[site]![2]] as [number, number], "end": [table[site]![3], table[site]![4]] as [number, number], ...summary(known) }))
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
