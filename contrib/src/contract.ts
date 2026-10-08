// What the editor reads from a run, as custom debug events (`DebugSession.sendEvent` with a DAP `event` message).
// Every position is in the text that ran: 0-based lines, and `[start, end)` offsets that the editor maps to its BABLR
// span ids, so a value or a count follows its code through edits and reformats.
//
// Status: `coverage` is read by the editor today. `values` and `evidence` are what tsval sends on the editor's
// internal hub; reading them from any debug session is the next change on the editor's side.

/** One value on a line: a name bound, a function's return, or the arm a branch chose. */
export interface LiveValue {
	"line": number;
	"name": string;
	"value": string;
	"kind": "bind" | "return" | "branch";
	/** The call it happened in (a `LiveCall.id`); 0 for the top level. */
	"call": number;
	/** The loop turns it happened on, outermost first. */
	"turns": number[];
	/** The node's offsets: what the margin anchors the value by. */
	"at"?: [number, number];
}

export interface LiveCall { "id": number; "name": string; "line": number; "at"?: [number, number] }

/** The `values` event: what's new since the last one, and how many values were dropped so far. */
export interface ValuesEvent { "file": string; "source"?: string; "values": LiveValue[]; "calls": LiveCall[]; "dropped": number }

export interface StatementCoverage {
	/** [line, character]. */
	"start": [number, number];
	"end": [number, number];
	"count": number;
	/** Offsets of what anchors it: an `if`'s condition, a function's name — the statement itself otherwise. */
	"anchor"?: [number, number];
}

/** What went through one observed site over a run. */
export interface SiteObservation {
	"site": "optional" | "nullish" | "branch" | "parameter" | "return";
	"start": [number, number];
	"end": [number, number];
	"seen"?: number;
	"nullish"?: number;
	"tags"?: Record<string, number>;
	"arms"?: number[];
}

/** The `coverage` event, sent as a run ends: every statement that could run, with how often it did (0 included). */
export interface CoverageEvent { "file": string; "source"?: string; "statements": StatementCoverage[]; "sites": SiteObservation[]; "files"?: CoverageEvent[] }

export interface Events {
	"values": ValuesEvent;
	"coverage": CoverageEvent;
}
