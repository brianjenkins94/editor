/* eslint-disable ts/no-unused-private-class-members -- vendored fork of macaly/almostnode — upstream/runtime idioms kept close to source, not restyled to this repo rules */
/**
 * What almostnode's `perf_hooks` has over unenv's (builtins.ts): a PerformanceObserver a program can create and observe
 * with (unenv's only says it isn't implemented) — it reports nothing.
 */

export class PerformanceObserver {
	private readonly callback: (list: PerformanceObserverEntryList) => void;
	private entryTypes: string[] = [];

	constructor(callback: (list: PerformanceObserverEntryList) => void) {
		this.callback = callback;
	}

	observe(options: { "entryTypes"?: string[]; "type"?: string }): void {
		this.entryTypes = options.entryTypes || (options.type ? [options.type] : []);
	}

	disconnect(): void {
		this.entryTypes = [];
	}

	takeRecords(): PerformanceEntry[] {
		return [];
	}

	static supportedEntryTypes = ["mark", "measure", "resource", "navigation"];
}

export interface PerformanceObserverEntryList {
	"getEntries": () => PerformanceEntry[];
	"getEntriesByName": (name: string, type?: string) => PerformanceEntry[];
	"getEntriesByType": (type: string) => PerformanceEntry[];
}

export interface PerformanceEntry {
	"name": string;
	"entryType": string;
	"startTime": number;
	"duration": number;
}
