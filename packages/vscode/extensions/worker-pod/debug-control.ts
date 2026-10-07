/**
 * The tsval debugger as hub RPC — so anything on the hub tree (debug-mcp's debug_* tools, and so an agent) can drive a
 * debug session the way VS Code's debug UI does, and read where it stopped.
 *
 *   pod     `debug.sessions`                       → every live session's summary
 *   pod     `debug.start` { program?, breakpoints?, args?, eventLoop? } → starts a session and answers with its first stop
 *   pod     `debug.explore` { program, maxRuns? }  → every ordering of its events run: the distinct outcomes (debug-adapter.ts)
 *   pod     `debug.breakpoints` { program?, lines }  → replaces a file's breakpoints (VS Code's own, so the UI shows them)
 *   pod     `rules.given` { program?, target } → what a rule gives the file's `target` (process.argv): { rule, values } | null
 *   pod     `rules.set` { previous?, rule? } → my policy changed by a rule editor: previous replaced by rule (or added, or removed)
 *   pod     `rules.list`                       → every rule, apart: { mine: { file, rules }, shared: { file, rules } } | null
 *   pod     `rules.placed` { program? }        → the rules placed in a file, where they are now: [{ whose, rule, status, line, endLine }]
 *   session `debug.session.<id>.step` { action }   → resumes, and answers with the NEXT stop (or the end)
 *   session `debug.session.<id>.state`             → where it is now
 *   session `debug.session.<id>.stop`              → ends it
 *   session `debug.session.<id>.decide` { choice, rule? } → at a capability stop: allow-once / allow-run / allow-always / deny, or
 *                                                     rule (saved in my policy, deciding it), then resumes
 *   session `debug.session.<id>.setValue` { name, value } → at a stop: a variable set to a literal; the run goes on with it
 *   session `debug.session.<id>.pace` { pace }      → what a timer's wait costs from here on: real, or none (Skip Waits)
 *   session `debug.session.<id>.stdin` { data }     → input for the program's process.stdin (as the Debug Console sends it)
 *
 * The session methods are served by the ADAPTER (debug-adapter.ts), not the worker: a breakpoint inside a React handler
 * blocks the worker in Atomics.wait, where only the adapter (which holds the shared control word) can resume it — and
 * the adapter owns the VS Code session, so a step from here shows in VS Code's UI too. Per-session subjects route each
 * action to exactly the pod that owns the session, even with several editor tabs linked to debug-mcp.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, serve } from "@brianjenkins94/hub";

import { given, placesOf, type Rule } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

import type { CapabilityChoice, StepAction } from "./debug-protocol";
import { loadEffectivePolicy, loadPolicyFiles, movePlace, replaceRule } from "../capabilities/silo-store";

export type DebugAction = StepAction;
const ACTIONS = new Set<string>(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"] satisfies DebugAction[]);
const CHOICES = new Set<string>(["allow-once", "allow-run", "allow-always", "deny", "rule", "give-once"] satisfies CapabilityChoice[]);

/** `starting` until the first stop; `idle` = a React app mounted and waiting for events (no stop to step from). */
export type DebugState = "starting" | "running" | "stopped" | "idle" | "terminated";

/** Where a session is — the answer to every session call. Location, code and locals only while stopped. */
export interface DebugOutcome {
	"session": string;
	"name": string;
	"program": string;
	"state": DebugState;
	/** Why it stopped: breakpoint, step, capability (a policy-gated call), … */
	"reason"?: string;
	/** The file it stopped in, when it's another of the program's files than `program` (MODULES.md). */
	"file"?: string;
	"line"?: number;
	"column"?: number;
	"function"?: string;
	/** The source line it stopped on. */
	"code"?: string;
	"locals"?: { "name": string; "value": string; "type": string }[];
	/** Its event loop at the stop, as the Variables view's Event loop scope shows it: the virtual clock, the pace, the
	 *  timers pending, the results waiting. */
	"eventLoop"?: { "name": string; "value": string; "type": string }[];
	/** What the program printed since the action began. */
	"output": string[];
}

/** What debug-adapter.ts's session exposes to the hub. */
export interface ControllableSession {
	"id": string;
	/** The `__launchId` a `debug.start` put in the launch config, to find the session it started. */
	"launchId"?: string;
	"outcome": () => DebugOutcome;
	/** Resume with `action` and resolve on the next stop, idle or end. Throws unless stopped. */
	"act": (action: DebugAction, signal: AbortSignal) => Promise<DebugOutcome>;
	/** Resolve once the session has left `starting`/`running` (now, if it already has). */
	"settled": (signal: AbortSignal) => Promise<DebugOutcome>;
	"stop": () => Promise<DebugOutcome>;
	/** At a capability stop, decide it and resume; resolve on the next stop, idle or end. */
	"decide": (choice: CapabilityChoice, signal: AbortSignal, rule?: Rule, give?: unknown) => Promise<DebugOutcome>;
	/** At a stop, set a variable in scope to a literal; resolve with it as the Variables view shows it. */
	"setValue": (name: string, value: string) => Promise<string>;
	/** What a timer's wait costs from here on: its real delay, or none (Skip Waits). */
	"pace": (pace: "real" | "fast") => void;
	/** Input for the program's process.stdin, as the Debug Console sends it. */
	"stdin": (data: string) => void;
}

const sessions = new Map<string, ControllableSession>();
/** `debug.start` calls waiting for the session their launch config marks. */
const pendingLaunches = new Map<string, (session: ControllableSession) => void>();

/** Serve `session`'s methods on `hub` until the returned disposer runs (when the session ends). */
export function registerSession(hub: Hub, session: ControllableSession): () => void {
	const prefix = "debug.session." + session.id + ".";
	const unserve = [
		serve(hub, prefix + "step", (args, { signal }) => {
			const action = (args as { "action"?: string } | undefined)?.action ?? "";

			if (!ACTIONS.has(action)) {
				throw new Error(`unknown action "${action}" — one of ${[...ACTIONS].join(", ")}`);
			}

			return session.act(action as DebugAction, signal);
		}),
		serve(hub, prefix + "state", () => session.outcome()),
		serve(hub, prefix + "stop", () => session.stop()),
		serve(hub, prefix + "decide", (args, { signal }) => {
			const { choice = "", rule, give } = (args ?? {}) as { "choice"?: string; "rule"?: Rule; "give"?: unknown };

			if (!CHOICES.has(choice)) {
				throw new Error(`unknown choice "${choice}" — one of ${[...CHOICES].join(", ")}`);
			}

			return session.decide(choice as CapabilityChoice, signal, rule, give);
		}),
		serve(hub, prefix + "setValue", (args) => {
			const { name, value } = (args ?? {}) as { "name"?: unknown; "value"?: unknown };

			if (typeof name !== "string" || typeof value !== "string") {
				throw new TypeError("setValue takes { name, value }: a variable's name and a literal as code writes it");
			}

			return session.setValue(name, value);
		}),
		serve(hub, prefix + "pace", (args) => {
			const { pace } = (args ?? {}) as { "pace"?: unknown };

			if (pace !== "real" && pace !== "fast") {
				throw new TypeError("pace takes { pace: \"real\" | \"fast\" }");
			}

			session.pace(pace);

			return null;
		}),
		serve(hub, prefix + "stdin", (args) => {
			const { data } = (args ?? {}) as { "data"?: unknown };

			if (typeof data !== "string") {
				throw new TypeError("stdin takes { data }: the input, as a string");
			}

			session.stdin(data);

			return null;
		})
	];

	sessions.set(session.id, session);

	if (session.launchId !== undefined) {
		pendingLaunches.get(session.launchId)?.(session);
		pendingLaunches.delete(session.launchId);
	}

	return () => {
		sessions.delete(session.id);
		unserve.forEach((dispose) => { dispose(); });
	};
}

/** A path as the launch config wants it: absolute, relative ones under the first workspace folder; the active editor's
 *  file when omitted. */
function resolveProgram(program: string | undefined): string {
	const path = program ?? vscode.window.activeTextEditor?.document.uri.path;

	if (path === undefined || path === "") {
		throw new Error("no program — pass one (e.g. src/index.ts), or open the file in the editor");
	}

	if (path.startsWith("/")) {
		return path;
	}

	return (vscode.workspace.workspaceFolders?.[0]?.uri.path ?? "/workspace").replace(/\/$/u, "") + "/" + path;
}

/** Replace `program`'s breakpoints with `lines` (1-based), through VS Code so its UI and every session see them. */
function setBreakpoints(program: string, lines: number[]): void {
	const uri = vscode.Uri.file(program);
	const existing = vscode.debug.breakpoints.filter((breakpoint) => breakpoint instanceof vscode.SourceBreakpoint && breakpoint.location.uri.toString() === uri.toString());

	vscode.debug.removeBreakpoints(existing);
	vscode.debug.addBreakpoints(lines.map((line) => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)))));
}

/** Serve the pod-level calls (list, start, breakpoints) on `hub`. */
/** Where a placed rule's place is now: how it was found (or that it's lost), its 1-based lines, and — when that isn't its
 *  stored place (followed there through edits, moved, or re-placed by a match) — the reference as it would be made there
 *  now. */
interface PlaceNow { "status": string; "line"?: number; "endLine"?: number; "ref"?: unknown }

/** What `editor.annotations.resolve` answers for one reference. */
interface Found { "status"?: string; "candidate"?: { "start"?: number; "end"?: number; "file"?: string }; "ref"?: unknown }

/** How a place found surely enough to act on was found: on its own span, moved, or re-placed by a strong match. */
const SURE = new Set(["attached", "moved", "re-placed"]);

/** A workspace file's text as it is now: its open document's (edits not yet saved included), else what's on disk. */
async function textOf(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

	return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** Where `place` is in `text` (of `file`), by the editor's BABLR — if in `file` at all. `before`: texts it may have been
 *  made against, for it to be followed from the one it was by the structural diff. */
async function resolvePlace(text: string, file: string, place: unknown, before: string[] = []): Promise<Found | undefined> {
	if (text === "") {
		return undefined; // nothing to find it in (and BABLR reads no empty text)
	}

	const [found] = await Promise.resolve(vscode.commands.executeCommand<(Found | undefined)[] | undefined>("editor.annotations.resolve", text, file, [place], { "texts": before })).catch(() => undefined) ?? [];

	return found?.status === undefined || found.status === "orphaned" || found.candidate?.start === undefined || (found.candidate.file !== undefined && found.candidate.file !== file) ? undefined : found;
}

/** How many of a file's latest edit bursts a placed rule is followed through. */
const HISTORY_STEPS = 30;

/** `place`, followed through `texts` (of `file`, oldest first) one at a time — each step from where it was last surely
 *  found, so an edit and the fix ESLint makes on save are two small steps rather than one jump too big to be sure of —
 *  to where it's surely found in the last (and how), or undefined if it isn't. It's followed from the latest text it's
 *  found in by its own span id (where it was placed, or unchanged since), so no lookalike from before then can take it. */
async function follow(place: unknown, texts: string[], file: string): Promise<{ "at": unknown; "found": Found } | undefined> {
	let from = texts.length - 1;

	while (from > 0 && (await resolvePlace(texts[from]!, file, place))?.status !== "attached") {
		from -= 1;
	}

	let at = place;
	let found: Found | undefined;

	for (let index = from; index < texts.length; index += 1) {
		// Each step from the texts before it — the reference was made against one of them — by the structural diff.
		found = await resolvePlace(texts[index]!, file, at, texts.slice(from, index));

		if (found !== undefined && SURE.has(found.status!) && found.ref !== undefined) {
			at = found.ref;
		}
	}

	return found !== undefined && SURE.has(found.status!) ? { "at": at, "found": found } : undefined;
}

/** Where each rule's place is now (RULES.md: *at*, a span reference) — followed through the edits made to its file since
 *  the last commit (the edit history's bursts, `history.texts`) to its text as it is now (unsaved edits included), or as
 *  saved (`saved`: for a place to be kept); looked for in it directly where it can't be followed surely (uncertain, or
 *  lost). Null for a rule with no place. The margin's marks, the Rules view and keeping places on save all see a rule
 *  where this finds it. */
async function placesNow(rpc: ReturnType<typeof createRpcClient>, rules: Rule[], saved = false): Promise<(PlaceNow | null)[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	/** Each file's texts to follow through, read once for all its rules. */
	const textsOf = new Map<string, Promise<string[]>>();
	const texts = (file: string): Promise<string[]> => {
		const known = textsOf.get(file) ?? (async (): Promise<string[]> => {
			const uri = vscode.Uri.joinPath(root!, file);
			const now = saved ? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) : await textOf(uri);
			const history = await rpc.request("history.texts", { "path": file }, { "timeoutMs": 10_000 }).catch(() => []) as string[];

			// The latest bursts (a long history needn't be walked from its start), ending at the text now — which the
			// history may not have caught up with yet.
			return [...history.slice(-HISTORY_STEPS), ...history.at(-1) === now ? [] : [now]];
		})();

		textsOf.set(file, known);

		return known;
	};

	return Promise.all(rules.map(async (rule) => {
		const [place] = placesOf(rule) as { "file"?: string }[];

		if (place === undefined || root === undefined || typeof place.file !== "string") {
			return null;
		}

		try {
			const chain = await texts(place.file);
			const text = chain.at(-1)!;
			const followed = await follow(place, chain, place.file);
			const found = followed?.found ?? await resolvePlace(text, place.file, place);

			if (found === undefined) {
				return { "status": "orphaned" };
			}

			const lineAt = (offset: number): number => text.slice(0, offset).split("\n").length;
			const { start, end } = found.candidate!;
			// The place it's at now, when that isn't the one stored: followed there, or found there by a match.
			const at = followed === undefined ? found.ref : followed.at === place ? undefined : followed.at;

			return { "status": found.status!, "line": lineAt(start!), "endLine": lineAt(end ?? start!), ...at === undefined ? {} : { "ref": at } };
		} catch {
			return { "status": "orphaned" };
		}
	}));
}

/** `rule` with its place (`at`'s argument) made `place`. */
function withPlace(rule: Rule, place: unknown): Rule {
	const walk = (predicate: Rule["when"]): Rule["when"] => ("predicates" in predicate ? { ...predicate, "predicates": predicate.predicates.map(walk) } : predicate.target_id === "at" && predicate.operator_id === "is" ? { ...predicate, "argument": place } : predicate) as Rule["when"];

	return { ...rule, "when": walk(rule.when) };
}

/** Each rule placed in `file` (workspace-relative) — mine and the shared contract's — followed to the file as saved
 *  (placesNow) and, surely found there somewhere other than its stored place (the statement moved, or changed but was
 *  followed or surely matched), kept at that place: its reference made again there, so it's found by its id from then
 *  on, rather than re-placed by hand (RULES.md). A shared rule's new place is a change to the contract, committed with
 *  the code change that moved its code. */
async function keepPlaces(rpc: ReturnType<typeof createRpcClient>, file: string): Promise<void> {
	const files = await loadPolicyFiles();
	const placed = (["mine", "shared"] as const).flatMap((whose) => (files?.[whose].rules ?? []).filter((rule) => (placesOf(rule) as { "file"?: string }[]).some((place) => place?.file === file)).map((rule) => ({ "whose": whose, "rule": rule })));

	if (placed.length === 0) {
		return;
	}

	const places = await placesNow(rpc, placed.map(({ rule }) => rule), true);

	for (const [index, { whose, rule }] of placed.entries()) {
		const place = places[index];

		if (place?.ref !== undefined && SURE.has(place.status)) {
			await movePlace(whose, rule, withPlace(rule, place.ref));
		}
	}
}

export function serveDebugControl(context: vscode.ExtensionContext, hub: Hub): void {
	const rpc = createRpcClient(hub);

	context.subscriptions.push(
		// A file saved: my rules placed in it keep the places they're found at.
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.scheme === "file") {
				void keepPlaces(rpc, vscode.workspace.asRelativePath(document.uri, false)).catch(() => undefined);
			}
		}),
		{ "dispose": serve(hub, "debug.sessions", () => [...sessions.values()].map((session) => {
			const { output: _output, locals: _locals, ...summary } = session.outcome();

			return summary;
		})) },
		{ "dispose": serve(hub, "debug.breakpoints", (args) => {
			// (`program` is any file: a breakpoint in one the program loads stops there)
			const { program, lines } = (args ?? {}) as { "program"?: string; "lines"?: number[] };
			const path = resolveProgram(program);

			setBreakpoints(path, lines ?? []);

			return { "program": path, "lines": lines ?? [] };
		}) },
		// What a rule gives a file's process.argv, for the notes margin's Mock (RULES.md) — matched here, where the policy
		// is, so the workbench loads no policy engine to draw a row.
		{ "dispose": serve(hub, "rules.given", async (args) => {
			const { program, target } = (args ?? {}) as { "program"?: string; "target"?: string };
			const path = resolveProgram(program);

			return given(await loadEffectivePolicy(), { "program": vscode.workspace.asRelativePath(vscode.Uri.file(path), false) }, target ?? "process.argv") ?? null;
		}) },
		// Every rule, for the Rules view (rules-view.ts): mine, then the shared contract's — and where each placed rule's
		// place is now (its line, or that it's uncertain or lost).
		{ "dispose": serve(hub, "rules.list", async () => {
			const files = await loadPolicyFiles();

			if (files === undefined) {
				return null;
			}

			return { "mine": { ...files.mine, "places": await placesNow(rpc, files.mine.rules) }, "shared": { ...files.shared, "places": await placesNow(rpc, files.shared.rules) } };
		}) },
		// The rules placed in a file, for the notes margin's marks (live-values.ts): each one, whose it is, and where it
		// is in the file as it is now (its lines, or uncertain) — lost ones left out (the Rules view says so).
		{ "dispose": serve(hub, "rules.placed", async (args) => {
			const { program } = (args ?? {}) as { "program"?: string };
			const file = vscode.workspace.asRelativePath(vscode.Uri.file(resolveProgram(program)), false);
			const files = await loadPolicyFiles();
			const placed = (["mine", "shared"] as const).flatMap((whose) => (files?.[whose].rules ?? []).filter((rule) => (placesOf(rule) as { "file"?: string }[]).some((place) => place?.file === file)).map((rule) => ({ "whose": whose, "rule": rule })));
			const places = await placesNow(rpc, placed.map(({ rule }) => rule));

			return placed.flatMap(({ whose, rule }, index) => {
				const { status, line, endLine } = places[index] ?? {};

				return status === undefined || status === "orphaned" || line === undefined ? [] : [{ "whose": whose, "rule": rule, "status": status, "line": line, "endLine": endLine ?? line }];
			});
		}) },
		{ "dispose": serve(hub, "rules.set", async (args) => {
			const { previous, rule } = (args ?? {}) as { "previous"?: Rule; "rule"?: Rule };

			await replaceRule(previous, rule);

			return rule ?? null;
		}) },
		{ "dispose": serve(hub, "debug.start", async (args, { signal }) => {
			const { program, breakpoints, "args": inputs, cases, eventLoop } = (args ?? {}) as { "program"?: string; "breakpoints"?: number[]; "args"?: string[]; "cases"?: string[][]; "eventLoop"?: unknown };
			const path = resolveProgram(program);
			const launchId = crypto.randomUUID();

			// Before the launch, so they're registered by the time the session starts running.
			if (breakpoints !== undefined) {
				setBreakpoints(path, breakpoints);
			}

			const launched = new Promise<ControllableSession>((resolve, reject) => {
				pendingLaunches.set(launchId, resolve);
				signal.addEventListener("abort", () => {
					pendingLaunches.delete(launchId);
					reject(signal.reason);
				}, { "once": true });
			});
			// `cases`: several runs, one after another (process.argv mocked with Multiple); answered with the first's first stop.
			const given = cases !== undefined && cases.length > 0 ? { "args": cases[0], "__cases": cases, "__case": 0 } : inputs === undefined ? {} : { "args": inputs };
			// `eventLoop`: an ordering to run again (debug.explore's: its clock, seed and schedule).
			const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "debug " + path.split("/").pop(), "program": path, ...given, ...eventLoop === undefined ? {} : { "eventLoop": eventLoop }, "__launchId": launchId });

			if (!started) {
				pendingLaunches.delete(launchId);

				throw new Error("VS Code didn't start the debug session");
			}

			return (await launched).settled(signal);
		}) }
	);
}
