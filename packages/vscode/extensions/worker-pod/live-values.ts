/**
 * A debug session's live values (LIVE-VALUES.md): what tsval's trace says each line bound, returned or chose, as the
 * panel beside the code shows it — each value a short preview, with its call and its loops' turns — kept bounded,
 * handed out a batch at a time. Pure: the debug worker feeds it, node tests it.
 *
 * Kept for the session only, in the worker's memory; nothing is written anywhere.
 */

/** One value on a line: a name bound (`low`), returned (`return`) or chosen (`if`, 0 its then), in a call, in the turn
 *  of each loop around it there (outermost first). Lines are 0-based, as VS Code's. */
export interface LiveValue {
	"line": number;
	"name": string;
	"value": string;
	/** `set`: a value set by hand at a stop (the margin, or the Variables view), not by the program. `input`: what the
	 *  program read from outside — process.argv, as a command line — on the first line that reads it. */
	"kind": "bind" | "return" | "branch" | "set" | "input";
	"call": number;
	"turns": number[];
	/** The node's range in the text that ran (offsets): what the margin anchors it by, so it follows its code through a
	 *  reformat (a BABLR span) rather than staying on a line number. */
	"at"?: [number, number];
}

/** A call: its function's name and the line it's declared on (0: the program's top level is call 0, not listed), and
 *  the function's range in the text that ran. */
export interface LiveCall { "id": number; "name": string; "line": number; "at"?: [number, number] }

/** What's new since the last batch, and how many values the bounds dropped so far. */
export interface LiveBatch { "values": LiveValue[]; "calls": LiveCall[]; "dropped": number }

/** What one trace event says, with its line and its call's function already read off its nodes. */
export interface Traced extends LiveValue {
	"step": number;
	/** The call's function, the first time a value of the call is told. */
	"callee"?: { "name": string; "line": number; "at"?: [number, number] };
	/** The trace's raw value, previewed here. */
	"raw"?: unknown;
}

export interface Bounds {
	/** A loop's turns kept: past this many, a value inside the loop is dropped. */
	"turns": number;
	/** Values kept per call. */
	"perCall": number;
	/** Calls kept: a value of a later call is dropped. */
	"calls": number;
}

export const BOUNDS: Bounds = { "turns": 50, "perCall": 2000, "calls": 200 };

const MAX_PREVIEW = 60;

/** `value` as code would write it, short: `'d'`, `5`, `['a', 'b', …]`, `{ x: 1, … }`, `ƒ twice`. Reads only own data
 *  properties — never a getter, so previewing can't run the program's code. */
export function preview(value: unknown, depth = 0): string {
	const text = previewOf(value, depth);

	return text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW - 1) + "…" : text;
}

function previewOf(value: unknown, depth: number): string {
	if (typeof value === "string") {
		return `'${value}'`;
	}

	if (value === null || typeof value !== "object" && typeof value !== "function") {
		return typeof value === "bigint" ? `${value}n` : String(value);
	}

	if (typeof value === "function") {
		return `ƒ ${(Object.getOwnPropertyDescriptor(value, "name")?.value as string | undefined) || "anonymous"}`;
	}

	const data = (key: PropertyKey): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);

		return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
	};

	if (Array.isArray(value)) {
		if (depth > 1) {
			return `Array(${value.length})`;
		}

		const shown = Math.min(value.length, 6);
		const items = Array.from({ "length": shown }, (_, index) => previewOf(data(index), depth + 1));

		return `[${items.join(", ")}${value.length > shown ? ", …" : ""}]`;
	}

	if (depth > 1) {
		return "{…}";
	}

	const keys = Object.keys(value);
	const shown = keys.slice(0, 4).map((key) => `${key}: ${previewOf(data(key), depth + 1)}`);

	return `{ ${shown.join(", ")}${keys.length > shown.length ? ", …" : ""} }`;
}

/** Where a record's telling is: the last value's step and its place among that step's values. */
export interface Told { "step": number; "place": number }

/** The record: values added as they're traced, drained a batch at a time. */
export class LiveRecord {
	private readonly bounds: Bounds;
	private pending: LiveValue[] = [];
	private pendingCalls: LiveCall[] = [];
	private readonly calls = new Map<number, number>();
	/** How many calls are known, the top level aside: counted, as each value of a call past the bound asks. */
	private listed = 0;
	private dropped = 0;
	/** The last value's step, and its place among that step's values (0 the first) — a statement tells several, and a
	 *  replay retells them in the same order, so (step, place) names a value. */
	private toldStep = -1;
	private toldPlace = -1;
	/** The latest (step, place) taken: anything not after it is a replay (see resume). */
	private lastStep = -1;
	private lastPlace = -1;

	public constructor(bounds: Bounds = BOUNDS) {
		this.bounds = bounds;
	}

	/** A traced value. One from no later than the last taken — an earlier step, or the same step's same place or an
	 *  earlier one — is a replay (the debugger stepped back and ran forward again) and is told already. */
	/** Where the telling is now — a stop keeps it, for a run that goes on from that stop again (resume). */
	public told(): Told {
		return { "step": this.toldStep, "place": this.toldPlace };
	}

	/** A run going on from a stop: its values are told again from where they were at that stop (`told`; none told yet,
	 *  without one) — so a value of the same step as ones told before the step back is known by its place among them. */
	public resume(told: Told = { "step": -1, "place": -1 }): void {
		this.toldStep = told.step;
		this.toldPlace = told.place;
	}

	public add(traced: Traced): void {
		this.toldPlace = traced.step === this.toldStep ? this.toldPlace + 1 : 0;
		this.toldStep = traced.step;

		if (traced.step < this.lastStep || (traced.step === this.lastStep && this.toldPlace <= this.lastPlace)) {
			return;
		}

		this.lastStep = traced.step;
		this.lastPlace = this.toldPlace;

		let count = this.calls.get(traced.call);

		// A call is known from its first value told, kept or not (the top level is call 0, never listed).
		if (count === undefined) {
			if (traced.call !== 0 && this.listed >= this.bounds.calls) {
				this.dropped += 1;

				return;
			}

			count = 0;
			this.calls.set(traced.call, 0);

			if (traced.call !== 0) {
				this.listed += 1;
				this.pendingCalls.push({ "id": traced.call, "name": traced.callee?.name ?? "anonymous", "line": traced.callee?.line ?? 0, ...traced.callee?.at === undefined ? {} : { "at": traced.callee.at } });
			}
		}

		if (count >= this.bounds.perCall || traced.turns.some((turn) => turn >= this.bounds.turns)) {
			this.dropped += 1;

			return;
		}

		this.calls.set(traced.call, count + 1);
		this.pending.push({ "line": traced.line, "name": traced.name, "value": "raw" in traced ? preview(traced.raw) : traced.value, "kind": traced.kind, "call": traced.call, "turns": traced.turns, ...traced.at === undefined ? {} : { "at": traced.at } });
	}

	/** What's new since the last batch (undefined when nothing is). */
	public drain(): LiveBatch | undefined {
		if (this.pending.length === 0 && this.pendingCalls.length === 0) {
			return undefined;
		}

		const batch = { "values": this.pending, "calls": this.pendingCalls, "dropped": this.dropped };

		this.pending = [];
		this.pendingCalls = [];

		return batch;
	}
}
