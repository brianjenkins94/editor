/**
 * What the editor reads from a run: the custom events a debugger sends (Debug Adapter Protocol `event` messages) —
 * tsval's, and any interpreter plugged in as `run.debugger` (editor-contrib's starting point). The editor turns each
 * into what it shows and keeps, the same way whichever debugger sent it:
 *
 * - `values`: shown in the margin beside their code, as they come;
 * - `coverage`: marks the lines that ran, and is kept as the run's evidence (`.silo/evidence/`);
 * - `effects`: what the run did to the world — each gated call, and how it went — kept in its envelope in the run ledger
 *   (`.silo/runs/`);
 * - `ended`: the run's values go from a file's margin, and how it ended short, if it did, is marked on its line. A
 *   debugger that sends none has its values cleared from the program's margin as its session ends.
 *
 * While stopped, the editor may ask for coverage so far with a `getCoverage` custom request: answer with a
 * `CoverageEvent`, or fail it if you don't keep one.
 *
 * Every position is in the text that ran: 0-based lines and characters, and `[start, end)` offsets that the editor maps
 * to its BABLR span ids, so a value or a count follows its code through edits and reformats.
 *
 * A live run — the editor runs the file again whenever typing pauses — has `__live: true` in its launch configuration.
 * It must not have effects (writes, requests, commands): skip them. A run the editor records has its id as `__runId`.
 */

/** One value on a line: a name bound (`low`), returned (`return`) or chosen (`if`, 0 its then), in a call, in the turn
 *  of each loop around it there (outermost first). */
export interface LiveValue {
	"line": number;
	"name": string;
	"value": string;
	/** `set`: a value set by hand at a stop, not by the program. `input`: what the program read from outside —
	 *  process.argv, as a command line — on the first line that reads it. `skip`: a call that wasn't made, its capability
	 *  and resource the value. */
	"kind": "bind" | "return" | "branch" | "set" | "input" | "skip";
	/** The call it happened in (a `LiveCall.id`); 0 for the top level. */
	"call": number;
	"turns": number[];
	/** The node's offsets: what the margin anchors the value by. */
	"at"?: [number, number];
}

/** A call: its function's name, the line it's declared on and the function's offsets (the top level is call 0, not
 *  listed). */
export interface LiveCall { "id": number; "name": string; "line": number; "at"?: [number, number] }

/** What's new since the last batch, and how many values were dropped so far (a debugger keeps them bounded). */
export interface LiveBatch { "values": LiveValue[]; "calls": LiveCall[]; "dropped": number }

/** The `values` event: a batch, of `file` — with the text that ran the first time a file's values are told. */
export interface ValuesEvent extends LiveBatch { "file": string; "source"?: string }

/** One statement's coverage: its range and how often it ran. */
export interface StatementCoverage {
	/** [line, character]. */
	"start": [number, number];
	"end": [number, number];
	"count": number;
	/** Offsets of what anchors it: its head for a statement with a body — an `if`'s condition, a function's name — whose
	 *  span outlives a reformat inside the body; the statement itself otherwise. */
	"anchor"?: [number, number];
}

/** A top-level statement's share of the run: its range and anchor, the statements run in its code, the virtual time
 *  waited before its code ran again, and the statement clock's reading when it first ran. */
export interface StatementProfile { "start": [number, number]; "anchor": [number, number]; "statements": number; "waited": number; "first": number }

/** What went through one observed site over a run: for a value site, how often a value came through, how often it was
 *  nullish, how often each type tag, and a few distinct primitives (kept on the machine, never committed); for a branch,
 *  how often each arm ran. */
export interface SiteObservation {
	"site": "optional" | "nullish" | "branch" | "parameter" | "return";
	"start": [number, number];
	"end": [number, number];
	"seen"?: number;
	"nullish"?: number;
	"tags"?: Record<string, number>;
	"samples"?: (string | number | boolean)[];
	"arms"?: number[];
}

/** The `coverage` event, sent as a run ends: every statement that could run, with how often it did (0 included), and
 *  every observed site that ran — the entry's, and (`files`) each other file of the program's that ran, with its text. */
export interface CoverageEvent { "file": string; "source"?: string; "statements": StatementCoverage[]; "sites": SiteObservation[]; "profile"?: StatementProfile[]; "files"?: CoverageEvent[] }

/** One kind of gated call a run made, and how it went: `made` for real; `denied` (it failed, as a refused call does);
 *  `skipped` (not made — the program went on as if it had done nothing); `given` (a rule's result in its place). A
 *  capability is `fs:read`, `fs:write`, `net`, `exec`, `eval`, `net.ws` or `net.webrtc`; its resource, the path, host or
 *  command it reached. */
export interface Effect { "capability": string; "resource": string; "how": "made" | "denied" | "skipped" | "given"; "calls": number }

/** The `effects` event: the run's effects so far — all of them, each telling; its last is the run's. */
export interface EffectsEvent { "effects": Effect[] }

/** How a run ended short: it crashed, or was stopped, on `line` (at `at`). */
export interface RunEnd { "kind": "crashed" | "stopped"; "line": number; "at"?: [number, number]; "message"?: string }

/** The `ended` event, once a file the run told values of (or ended short in): its values go, and its end is marked. */
export interface EndedEvent { "file": string; "source"?: string; "end"?: RunEnd }

/** Every event, by its name. */
export interface Events {
	"values": ValuesEvent;
	"coverage": CoverageEvent;
	"effects": EffectsEvent;
	"ended": EndedEvent;
}
