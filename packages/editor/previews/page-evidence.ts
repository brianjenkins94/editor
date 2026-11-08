/**
 * The page runtime of runtime evidence (RUNTIME-EVIDENCE.md, the third slice): what a preview's instrumented modules
 * (almostnode's frameworks/instrument.ts) tell `globalThis.__evidence`, counted in the page — statements as they start,
 * what went through each site — and reported to the editor (page-script.ts).
 *
 * Counts are page-global, by file and version (the module source's git blob oid): a module a hot update re-imports
 * with an edit counts into its new version, one re-imported unchanged counts on into its old one; a module's own scope
 * would lose them on every update. A report is a page's totals since it loaded, not what changed since the last, so a
 * lost one costs nothing. A page reports every 10 seconds while its counts change, on each hot update (before the
 * module is re-imported), and on `pagehide`.
 *
 * A breakpoint in a page's code (recorded stops) isn't back: the instrumenter calls its operations only for a stop, so
 * here they do nothing.
 */
import type { SiteObservation } from "@brianjenkins94/editor-api";
import type { ModuleEvidence } from "@brianjenkins94/editor-api/recorded";
import type { ObserveSite } from "@brianjenkins94/tsval";
import { esmPackage } from "@brianjenkins94/editor-api/recorded";
import { typeTag } from "@brianjenkins94/tsval/values";

/** What a site of a module records: a statement (coverage), or one of tsval's observe sites (instrument.ts). */
type SiteKind = "statement" | ObserveSite;

/** A site of the module's table: its kind and its node's range (0-based line and character). */
type Entry = [SiteKind, number, number, number, number];

/** The runtime operations an instrumented module calls (instrument.ts); a recorded stop's (`p`, `e`, `k`, `x`) only
 *  for a stop, which isn't back. */
interface Ops {
	"s": (site: number) => void;
	"v": (site: number, value: unknown) => unknown;
	"c": (site: number, before: number, value: unknown) => unknown;
	"b": (site: number, value: unknown) => unknown;
	"a": (site: number, value: unknown) => unknown;
	"o": (site: number, value: unknown) => unknown;
	"p": () => void;
	"e": () => undefined;
	"k": (at: unknown, value: unknown) => unknown;
	"x": () => void;
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
	const ranked = Object.entries(tags).sort(([, left], [, right]) => right - left);

	return ranked.length <= MAX_TAGS
		? tags
		: {
				...Object.fromEntries(ranked.slice(0, MAX_TAGS - 1)),
				"other": ranked.slice(MAX_TAGS - 1).reduce((sum, [, count]) => sum + count, 0)
			};
}

/**
 * Count what the page's instrumented modules tell `globalThis.__evidence`, and call `report` with every version's
 * evidence when it's time. Returns `flush`, which reports now.
 */
/** The packages a page loaded from esm.sh, by name@version (sorted): each exact version its modules came from — the
 *  entry URL names a range (`react@^19`), and the stub it answers imports the version it resolved (`/react@19.3.0/…`). */
export function loadedPackages(urls: string[]): string[] {
	const found = new Set<string>();

	for (const url of urls) {
		const served = esmPackage(url);

		if (served?.version !== undefined) {
			found.add(`${served.name}@${served.version}`);
		}
	}

	return [...found].toSorted();
}

/** What this page loaded, as loadedPackages tells it from the page's resource timing. */
function pagePackages(): string[] {
	return loadedPackages(performance.getEntriesByType("resource").map((entry) => entry.name));
}

export function installPageEvidence(report: (modules: ModuleEvidence[], packages: string[]) => void): { "flush": () => void } {
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
				mine = {
					"first": tag,
					"firstCount": 0,
					"others": undefined,
					"samples": []
				};
				kinds[site] = mine;
			}

			if (tag === mine.first) {
				mine.firstCount += 1;
			} else {
				mine.others ??= {};
				mine.others[tag] = (mine.others[tag] ?? 0) + 1;
			}

			if (mine.samples.length < MAX_SAMPLES) {
				let sample: string | number | boolean | undefined;

				if (typeof observed === "string") {
					sample = observed.slice(0, SAMPLE_CHARS);
				} else if (typeof observed === "boolean" || (typeof observed === "number" && Number.isFinite(observed))) {
					sample = observed;
				}

				if (sample !== undefined && !mine.samples.includes(sample)) {
					mine.samples.push(sample);
				}
			}

			return observed;
		};

		const ops: Ops = {
			"s": (site) => {
				counts[site] += 1;
				changed = true;
			},
			"v": value,
			"c": (site, before, observed) => {
				if (stopped[before] === 1) {
					stopped[site] = 1;

					return observed;
				}

				return value(site, observed);
			},
			"b": (site, observed) => {
				arms[site * 2 + (observed ? 0 : 1)] += 1;
				changed = true;

				return observed;
			},
			"a": (site, observed) => {
				arms[site * 2 + (observed ? 0 : 1)] += 1;
				changed = true;

				return observed;
			},
			"o": (site, observed) => {
				arms[site * 2 + (observed ? 1 : 0)] += 1;
				changed = true;

				return observed;
			},
			"p": () => undefined,
			"e": () => undefined,
			"k": (_at, made) => made,
			"x": () => undefined
		};

		versions.set(key, {
			"file": file,
			"version": version,
			"table": table,
			"counts": counts,
			"seen": seen,
			"nullish": nullish,
			"arms": arms,
			"kinds": kinds,
			"ops": ops
		});

		return ops;
	};

	const evidence = (): ModuleEvidence[] => [
		...versions.values()
	].map(({ file, version, table, counts, seen, nullish, arms, kinds }) => ({
		"file": file,
		"version": version,
		"statements": table.flatMap(([kind, ...range], site) => (kind === "statement"
			? [
					{
						"start": [range[0], range[1]] as [number, number],
						"end": [range[2], range[3]] as [number, number],
						"count": counts[site]
					}
				]
			: [])),
		"sites": table.flatMap(([kind, ...range], site): SiteObservation[] => {
			const at = {
				"site": kind as ObserveSite,
				"start": [range[0], range[1]] as [number, number],
				"end": [range[2], range[3]] as [number, number]
			};

			if (kind === "branch") {
				const [taken, other] = [arms[site * 2] ?? 0, arms[site * 2 + 1] ?? 0];

				return taken + other === 0
					? []
					: [
							{
								...at,
								"arms": [taken, other]
							}
						];
			}

			const mine = kinds[site];

			return kind === "statement" || mine === undefined
				? []
				: [
						{
							...at,
							"seen": seen[site],
							"nullish": nullish[site],
							"tags": capped({ [mine.first]: mine.firstCount, ...mine.others }),
							...mine.samples.length > 0
								? { "samples": mine.samples }
								: {}
						}
					];
		})
	}));

	const flush = (): void => {
		if (versions.size > 0) {
			changed = false;
			report(evidence(), pagePackages());
		}
	};

	// `module` is what instrumented modules call; `evidence` reads what the page has counted (for a debugger, a test).
	Object.assign(globalThis, {
		"__evidence": { "module": module, "evidence": evidence }
	});
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
