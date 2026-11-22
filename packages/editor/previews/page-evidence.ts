import type { SiteObservation } from "@brianjenkins94/editor-api";
import type { Encoded } from "@brianjenkins94/editor-api/recorded";
import type { ModuleEvidence, RecordedStop, Replay, StopHit } from "@brianjenkins94/editor-api/recorded";
import type { ObserveSite } from "@brianjenkins94/tsval";
import { encode } from "@brianjenkins94/editor-api/recorded";
import { esmPackage } from "@brianjenkins94/editor-api/recorded";
import { preview } from "@brianjenkins94/editor-api/values";
import { typeTag } from "@brianjenkins94/tsval/values";

type SiteKind = "statement" | ObserveSite;

type Entry = [SiteKind, number, number, number, number];

interface Ops {
	"s": (site: number) => void;
	"v": (site: number, value: unknown) => unknown;
	"c": (site: number, before: number, value: unknown) => unknown;
	"b": (site: number, value: unknown) => unknown;
	"a": (site: number, value: unknown) => unknown;
	"o": (site: number, value: unknown) => unknown;
	"p": (at: [number, number, number, number], scope: () => Record<string, unknown>, self: () => unknown, where: string) => void;
	"e": (fn: [number, number, number, number], free: () => Record<string, unknown>, self: () => unknown, args: ArrayLike<unknown>) => Recording;
	"k": (at: [number, number], value: unknown) => unknown;
	"x": (recording: Recording) => void;
}

interface Recording { "replay": Replay; "hit"?: StopHit }

const MAX_REPLAYS = 5;

function stopPreview(value: unknown): string {
	if (typeof Node !== "undefined" && value instanceof Element) {
		return `<${value.tagName.toLowerCase()}${value.id === "" ? "" : "#" + value.id}${[...value.classList].map((name) => "." + name).join("")}>`;
	}

	if (typeof Node !== "undefined" && value instanceof Node) {
		return value.nodeName.toLowerCase();
	}

	if (typeof Event !== "undefined" && value instanceof Event) {
		return `${value.constructor.name} ${value.type}`;
	}

	return preview(value);
}

const MAX_HITS = 20;
const STOP_REPORT_MS = 150;


const REPORT_MS = 10_000;
const MAX_TAGS = 8;
const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 40;

interface Kinds { "first": string; "firstCount": number; "others": Record<string, number> | undefined; "samples": (string | number | boolean)[] }

function capped(tags: Record<string, number>): Record<string, number> {
	const ranked = Object.entries(tags).sort(([, left], [, right]) => right - left);

	return ranked.length <= MAX_TAGS
		? tags
		: {
				...Object.fromEntries(ranked.slice(0, MAX_TAGS - 1)),
				"other": ranked.slice(MAX_TAGS - 1).reduce((sum, [, count]) => sum + count, 0)
			};
}

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

function pagePackages(): string[] {
	return loadedPackages(performance.getEntriesByType("resource").map((entry) => entry.name));
}

export function installPageEvidence(report: (modules: ModuleEvidence[], packages: string[]) => void, reportStops: (stops: RecordedStop[]) => void = () => undefined): { "flush": () => void } {
	const stops = new Map<string, RecordedStop & { "count": number }>();
	let stopTimer: ReturnType<typeof setTimeout> | undefined;
	const stopsNow = (): void => {
		stopTimer = undefined;
		reportStops([...stops.values()].map(({ "count": _count, ...stop }) => stop));
	};

	const calls: Recording[] = [];
	const stopHit = (file: string, version: string, at: [number, number, number, number], scope: () => Record<string, unknown>, self: () => unknown, where: string): void => {
		const key = `${file}\0${version}\0${at.join(",")}`;
		const stop = stops.get(key) ?? { "file": file, "version": version, "at": at, "where": where, "hits": [], "count": 0 };
		const values: [string, string][] = [];

		try {
			for (const [name, value] of Object.entries(scope())) {
				values.push([name, stopPreview(value)]);
			}
		} catch { /* a name not readable now: what was read stands */ }

		try {
			const me = self();

			if (me !== undefined && me !== globalThis) {
				values.push(["this", stopPreview(me)]);
			}
		} catch { /* before super(): no this yet */ }

		const event = (globalThis as { "event"?: { "type"?: unknown } }).event?.type;

		const hit: StopHit = { "n": stop.count + 1, ...typeof event === "string" ? { "event": event } : {}, "values": values };

		stop.count += 1;
		stop.hits = [...stop.hits, hit].slice(-MAX_HITS);
		stop.hits.slice(0, -MAX_REPLAYS).forEach((older) => {
			delete older.replay;
		});

		const recording = calls.at(-1);

		if (recording !== undefined) {
			recording.hit = hit;
		}

		stops.set(key, stop);
		stopTimer ??= setTimeout(stopsNow, STOP_REPORT_MS);
	};

	const safely = <T>(read: () => T, otherwise: T): T => {
		try {
			return read();
		} catch {
			return otherwise;
		}
	};

	const enter = (fn: [number, number, number, number], free: () => Record<string, unknown>, self: () => unknown, args: ArrayLike<unknown>): Recording => {
		const recording: Recording = { "replay": { "fn": fn, "free": Object.fromEntries(Object.entries(safely(free, {})).map(([name, value]) => [name, encode(value)])), "self": encode(safely(self, undefined)), "args": Array.from(args, (arg) => encode(arg)), "calls": [] } };

		calls.push(recording);

		return recording;
	};

	const made = (at: [number, number], value: unknown): unknown => {
		const recording = calls.at(-1);

		if (recording !== undefined) {
			const slot: [number, number, Encoded] = [at[0], at[1], encode(value)];

			recording.replay.calls.push(slot);

			if (value !== null && typeof value === "object" && typeof (value as { "then"?: unknown }).then === "function") {
				void (value as Promise<unknown>).then((settled) => {
					slot[2] = { "$": "p", "v": encode(settled) };
				}, (reason: unknown) => {
					slot[2] = { "$": "pr", "v": encode(reason) };
				});
			}
		}

		return value;
	};

	const leave = (recording: Recording): void => {
		const at = calls.lastIndexOf(recording);

		if (at !== -1) {
			calls.splice(at);
		}

		if (recording.hit !== undefined) {
			recording.hit.replay = recording.replay;
			stopTimer ??= setTimeout(stopsNow, STOP_REPORT_MS);
		}
	};

	const versions = new Map<string, { "file": string; "version": string; "table": Entry[]; "counts": Uint32Array; "seen": Uint32Array; "nullish": Uint32Array; "arms": Uint32Array; "kinds": (Kinds | undefined)[]; "ops": Ops }>();
	let changed = false;

	const module = (file: string, version: string, table: Entry[]): Ops => {
		const key = `${file}\0${version}`;
		const known = versions.get(key);

		if (known !== undefined) {
			return known.ops;
		}

		const counts = new Uint32Array(table.length);
		const seen = new Uint32Array(table.length);
		const nullish = new Uint32Array(table.length);
		const arms = new Uint32Array(table.length * 2);
		const kinds: (Kinds | undefined)[] = [];
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
			"p": (at, scope, self, where) => { stopHit(file, version, at, scope, self, where); },
			"e": enter,
			"k": made,
			"x": leave
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

	Object.assign(globalThis, {
		"__evidence": { "module": module, "evidence": evidence }
	});
	setInterval(() => {
		if (changed) {
			flush();
		}
	}, REPORT_MS);
	addEventListener("message", (event: MessageEvent) => {
		if ((event.data as { "channel"?: unknown } | null)?.channel === "vite-hmr") {
			flush();
		}
	});
	addEventListener("pagehide", flush);

	return { "flush": flush };
}
