/**
 * The tsval debugger as hub RPC — so anything on the hub tree (debug-mcp's debug_* tools, and so an agent) can drive a
 * debug session the way VS Code's debug UI does, and read where it stopped.
 *
 *   pod     `debug.sessions`                       → every live session's summary
 *   pod     `debug.start` { program?, breakpoints?, args? } → starts a session and answers with its first stop
 *   pod     `debug.breakpoints` { program?, lines }  → replaces a file's breakpoints (VS Code's own, so the UI shows them)
 *   pod     `rules.given` { program?, target } → what a rule gives the file's `target` (process.argv): { rule, values } | null
 *   pod     `rules.set` { previous?, rule? } → my policy changed by a rule editor: previous replaced by rule (or added, or removed)
 *   pod     `rules.list`                       → every rule, apart: { mine: { file, rules }, shared: { file, rules } } | null
 *   session `debug.session.<id>.step` { action }   → resumes, and answers with the NEXT stop (or the end)
 *   session `debug.session.<id>.state`             → where it is now
 *   session `debug.session.<id>.stop`              → ends it
 *   session `debug.session.<id>.decide` { choice, rule? } → at a capability stop: allow-once / allow-always / deny, or
 *                                                     rule (saved in my policy, deciding it), then resumes
 *   session `debug.session.<id>.setValue` { name, value } → at a stop: a variable set to a literal; the run goes on with it
 *
 * The session methods are served by the ADAPTER (debug-adapter.ts), not the worker: a breakpoint inside a React handler
 * blocks the worker in Atomics.wait, where only the adapter (which holds the shared control word) can resume it — and
 * the adapter owns the VS Code session, so a step from here shows in VS Code's UI too. Per-session subjects route each
 * action to exactly the pod that owns the session, even with several editor tabs linked to debug-mcp.
 */
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import { given, placesOf, type Rule } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

import type { CapabilityChoice, StepAction } from "./debug-protocol";
import { loadEffectivePolicy, loadPolicyFiles, replaceRule } from "../capabilities/silo-store";

export type DebugAction = StepAction;
const ACTIONS = new Set<string>(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"] satisfies DebugAction[]);
const CHOICES = new Set<string>(["allow-once", "allow-always", "deny", "rule"] satisfies CapabilityChoice[]);

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
	"line"?: number;
	"column"?: number;
	"function"?: string;
	/** The source line it stopped on. */
	"code"?: string;
	"locals"?: { "name": string; "value": string; "type": string }[];
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
	"decide": (choice: CapabilityChoice, signal: AbortSignal, rule?: Rule) => Promise<DebugOutcome>;
	/** At a stop, set a variable in scope to a literal; resolve with it as the Variables view shows it. */
	"setValue": (name: string, value: string) => Promise<string>;
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
			const { choice = "", rule } = (args ?? {}) as { "choice"?: string; "rule"?: Rule };

			if (!CHOICES.has(choice)) {
				throw new Error(`unknown choice "${choice}" — one of ${[...CHOICES].join(", ")}`);
			}

			return session.decide(choice as CapabilityChoice, signal, rule);
		}),
		serve(hub, prefix + "setValue", (args) => {
			const { name, value } = (args ?? {}) as { "name"?: unknown; "value"?: unknown };

			if (typeof name !== "string" || typeof value !== "string") {
				throw new TypeError("setValue takes { name, value }: a variable's name and a literal as code writes it");
			}

			return session.setValue(name, value);
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
/** Where each rule's place is now (RULES.md: *at*, a span reference) — found in its file as it is, through edits, by
 *  the editor's BABLR: its 1-based line and how it was found, or that it's lost; null for a rule with no place. */
async function placesNow(rules: Rule[]): Promise<({ "status": string; "line"?: number } | null)[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;

	return Promise.all(rules.map(async (rule) => {
		const [place] = placesOf(rule) as { "file"?: string }[];

		if (place === undefined || root === undefined || typeof place.file !== "string") {
			return null;
		}

		try {
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, place.file)));
			const [found] = await Promise.resolve(vscode.commands.executeCommand<({ "status"?: string; "candidate"?: { "start"?: number; "file"?: string } } | undefined)[] | undefined>("editor.annotations.resolve", text, place.file, [place])) ?? [];
			const start = found?.candidate?.start;

			return found?.status === undefined || found.status === "orphaned" || start === undefined || (found.candidate?.file !== undefined && found.candidate.file !== place.file) ? { "status": "orphaned" } : { "status": found.status, "line": text.slice(0, start).split("\n").length };
		} catch {
			return { "status": "orphaned" };
		}
	}));
}

export function serveDebugControl(context: vscode.ExtensionContext, hub: Hub): void {
	context.subscriptions.push(
		{ "dispose": serve(hub, "debug.sessions", () => [...sessions.values()].map((session) => {
			const { output: _output, locals: _locals, ...summary } = session.outcome();

			return summary;
		})) },
		{ "dispose": serve(hub, "debug.breakpoints", (args) => {
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

			return { "mine": { ...files.mine, "places": await placesNow(files.mine.rules) }, "shared": { ...files.shared, "places": await placesNow(files.shared.rules) } };
		}) },
		{ "dispose": serve(hub, "rules.set", async (args) => {
			const { previous, rule } = (args ?? {}) as { "previous"?: Rule; "rule"?: Rule };

			await replaceRule(previous, rule);

			return rule ?? null;
		}) },
		{ "dispose": serve(hub, "debug.start", async (args, { signal }) => {
			const { program, breakpoints, "args": inputs, cases } = (args ?? {}) as { "program"?: string; "breakpoints"?: number[]; "args"?: string[]; "cases"?: string[][] };
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
			const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "debug " + path.split("/").pop(), "program": path, ...given, "__launchId": launchId });

			if (!started) {
				pendingLaunches.delete(launchId);

				throw new Error("VS Code didn't start the debug session");
			}

			return (await launched).settled(signal);
		}) }
	);
}
