/**
 * silo — the effect journal (v1: the effect GRAPH). An ordered, persistable record of the capability effects a
 * program reaches (from the canary's event stream), and a diff of two runs to detect DRIFT — a call added or
 * removed, or the same call reaching a different resource (a URL/path/command that changed). It is the keystone
 * the rest hangs on: replay, idempotency, and value/response drift all build on this ordered log.
 *
 * v1 records the effect identity + resolved resource (no real result — the canary runs in observe mode, so it
 * captures WHAT the program does, not the responses it got). Recording real results for replay (a `perform`
 * hook, response-body drift) is v2. Drift here is intentional-vs-unintentional-agnostic; correlating it with a
 * code-hash to make that call is a later layer.
 *
 * Dev-linked to ../tsval through ./canary; kept out of the CI sweep until tsval publishes.
 */

import { interpret } from "@brianjenkins94/tsval";
import { ALL_CAPABILITIES, runCanary } from "./canary";

/** One effect in program order. `value` is the resolved resource (Axis-2); `callee`+`capability` its identity. */
export interface JournalEntry {
	"seq": number;
	"capability": string;
	"callee": string;
	"value": string;
	"safe"?: boolean;
	/** the arguments the call received (v2 record — must be JSON-serializable for a persisted journal). */
	"args"?: unknown[];
	/** the result the source returned (v2 record — the recorded RESPONSE, fed back on replay). */
	"result"?: unknown;
}

export interface Journal {
	"fileName": string;
	"entries": JournalEntry[];
}

/** Query params that carry no identity — cache-busters, nonces, timestamps — dropped when matching. */
const VOLATILE_PARAMS = new Set(["t", "_", "ts", "timestamp", "nonce", "cache", "cachebust", "cb", "rand"]);

/** Canonicalize a resource for matching so replay/drift ignore noise: for an absolute URL, drop volatile query
 *  params and sort the rest; every other value (relative paths, commands, env keys) passes through unchanged. */
export function normalizeValue(value: string): string {
	let url: URL;

	try { url = new URL(value); } catch { return value; }

	const params = [...url.searchParams].filter(([key]) => !VOLATILE_PARAMS.has(key)).sort((a, b) => a[0].localeCompare(b[0]));

	url.search = new URLSearchParams(params).toString();

	return url.toString();
}

/** Run the program and capture its ordered effect graph. */
export function recordJournal(fileName: string, src: string): Journal {
	const report = runCanary(src, { "predicted": [...ALL_CAPABILITIES], "fileName": fileName });

	return {
		"fileName": fileName,
		"entries": report.observed.map((event, seq) => ({
			"seq": seq,
			"capability": event.capability,
			"callee": event.callee,
			"value": event.value,
			"safe": event.safe
		}))
	};
}

export interface DriftOp {
	"op": "same" | "changed" | "added" | "removed";
	"before"?: JournalEntry;
	"after"?: JournalEntry;
}

export interface DriftReport {
	"drifted": boolean;
	"ops": DriftOp[];
}

/** The stable part of an entry's identity — the call, not the (possibly drifting) resource. */
function keyOf(entry: JournalEntry): string {
	return `${entry.capability}|${entry.callee}`;
}

/** Align two effect graphs by an LCS over their call identities, then within each aligned pair compare the
 *  resource: equal → `same`, different → `changed` (value drift). Unaligned entries are `added`/`removed`. */
function diffEntries(before: JournalEntry[], after: JournalEntry[]): DriftOp[] {
	const n = before.length;
	const m = after.length;
	const lcs = Array.from({ "length": n + 1 }, () => new Array<number>(m + 1).fill(0));

	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			lcs[i][j] = keyOf(before[i]) === keyOf(after[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const ops: DriftOp[] = [];
	let i = 0;
	let j = 0;

	while (i < n && j < m) {
		if (keyOf(before[i]) === keyOf(after[j])) {
			ops.push({ "op": normalizeValue(before[i].value) === normalizeValue(after[j].value) ? "same" : "changed", "before": before[i], "after": after[j] });
			i += 1;
			j += 1;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			ops.push({ "op": "removed", "before": before[i] });
			i += 1;
		} else {
			ops.push({ "op": "added", "after": after[j] });
			j += 1;
		}
	}

	while (i < n) { ops.push({ "op": "removed", "before": before[i] }); i += 1; }
	while (j < m) { ops.push({ "op": "added", "after": after[j] }); j += 1; }

	return ops;
}

/** Record `src` afresh and diff it against a prior `journal` — the drift check. */
export function driftAgainst(journal: Journal, fileName: string, src: string): DriftReport {
	const ops = diffEntries(journal.entries, recordJournal(fileName, src).entries);

	return { "drifted": ops.some((op) => op.op !== "same"), "ops": ops };
}

/** The resource string a source call is "about" — its first string argument (URL / path / query). */
function resourceOf(args: unknown[]): string {
	return typeof args[0] === "string" ? args[0] : "";
}

/** v2 record: the real functions to journal, keyed by the global name the guest calls (`fetch`, `db`, …). */
export interface RecordOptions {
	"perform": Record<string, (...args: unknown[]) => unknown>;
}

/**
 * v2 — record real RESULTS. Run `src` with each named source wrapped so its call is performed for real and the
 * (identity, args, result) captured in order. The returned journal's `result`s are what `replay` feeds back.
 * `perform` functions should be synchronous and return JSON-serializable data for a persistable journal.
 */
export function record(fileName: string, src: string, options: RecordOptions): { "journal": Journal; "completion": unknown } {
	const entries: JournalEntry[] = [];
	const globals: Record<string, unknown> = {};

	for (const [name, fn] of Object.entries(options.perform)) {
		globals[name] = (...args: unknown[]) => {
			const result = fn(...args);

			entries.push({ "seq": entries.length, "capability": "", "callee": name, "value": resourceOf(args), "args": args, "result": result });

			return result;
		};
	}

	const completion = interpret(src, { "globals": globals });

	return { "journal": { "fileName": fileName, "entries": entries }, "completion": completion };
}

/**
 * v2 — REPLAY a journal. Run `src` with each recorded source returning its recorded result (per-callee, in
 * order) instead of performing anything, and report drift: a call with no recorded entry left (`added`), a
 * recorded entry never re-reached (`removed`), or a matched call whose resource changed (`changed`).
 */
export function replay(_fileName: string, src: string, journal: Journal): { "completion": unknown; "drift": DriftReport } {
	const queues = new Map<string, JournalEntry[]>();

	for (const entry of journal.entries) {
		const queue = queues.get(entry.callee);

		if (queue === undefined) { queues.set(entry.callee, [entry]); } else { queue.push(entry); }
	}

	const ops: DriftOp[] = [];
	const globals: Record<string, unknown> = {};

	for (const name of new Set(journal.entries.map((entry) => entry.callee))) {
		globals[name] = (...args: unknown[]) => {
			const entry = queues.get(name)?.shift();
			const value = resourceOf(args);

			if (entry === undefined) {
				ops.push({ "op": "added", "after": { "seq": -1, "capability": "", "callee": name, "value": value } });

				return undefined;
			}

			ops.push(normalizeValue(entry.value) === normalizeValue(value) ? { "op": "same", "before": entry, "after": entry } : { "op": "changed", "before": entry, "after": { ...entry, "value": value } });

			return entry.result;
		};
	}

	const completion = interpret(src, { "globals": globals });

	for (const queue of queues.values()) {
		for (const entry of queue) { ops.push({ "op": "removed", "before": entry }); }
	}

	return { "completion": completion, "drift": { "drifted": ops.some((op) => op.op !== "same"), "ops": ops } };
}

/** Render a drift report; `same` lines are omitted unless `verbose`. */
export function formatDrift(report: DriftReport, verbose = false): string {
	const glyph = { "same": "  ", "changed": "~ ", "added": "+ ", "removed": "- " } as const;
	const lines: string[] = [];

	for (const op of report.ops) {
		if (op.op === "same" && !verbose) { continue; }
		const entry = op.after ?? op.before;
		const resource = op.op === "changed" ? `${op.before?.value} → ${op.after?.value}` : entry?.value;

		lines.push(`${glyph[op.op]}${entry?.capability} ${entry?.callee}  ${resource}`);
	}

	lines.push("");
	lines.push(report.drifted ? "verdict: DRIFTED" : "verdict: no drift");

	return lines.join("\n");
}
