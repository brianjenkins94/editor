/**
 * The program's capabilities, decided per call (RUNNING.md, *Effects are real, decided per call*): its `fs`,
 * `child_process` and `fetch` gated — made, skipped, denied or given — a stop's resource probed, and each call counted
 * among the run's effects.
 */
import type { Effect } from "@brianjenkins94/editor-api";
import type { HostGuard } from "@brianjenkins94/tsval";
import type { Runtime } from "./runtime";
import type { Place, Vm } from "./state";
import { triggerOf, verdictOf } from "@brianjenkins94/editor-api/gate";
import { UNCATCHABLE } from "@brianjenkins94/tsval";
import { givenResult } from "@brianjenkins94/util/silo/policy";
import ts from "typescript";
import { capabilityBreakLines } from "../capability-calls";
import { capabilityStandins, standinCapability, givenAs } from "../canary";
import { EXITED, stdin } from "./process";
import { guestConsole, placeOf } from "./session";
import { post, state } from "./state";

/** The run's effects (the run contract's `Effect`): each gated call it made, was denied, skipped or was given, by its
 *  capability and resource — told the adapter as the run ends, for the run ledger (its envelope's `effects`). */
const effects = new Map<string, Effect>();

let tallying = false;

/** A gated call, counted among the run's effects — a package's (`pkg`, its name@version) apart from the program's — with
 *  how it was decided: within the package's baseline, by the policy, or at the call (the person's answer). */
export function tally(capability: string, resource: string, how: Effect["how"], pkg?: string, decided?: Effect["decided"]): void {
	// (a package's call is an effect of each of the program's calls it's in: the program's own are told at their gate)
	if (pkg !== undefined) {
		state.evaluating?.impure("effect", capability);
	}

	if (!tallying) {
		return;
	}

	const key = `${how}\0${capability}\0${resource}\0${pkg ?? ""}\0${decided ?? ""}`;
	const known = effects.get(key);

	if (known === undefined) {
		effects.set(key, { "capability": capability, "resource": resource, "how": how, "calls": 1, ...pkg === undefined ? {} : { "package": pkg }, ...decided === undefined ? {} : { "decided": decided } });
	} else {
		known.calls += 1;
	}
}

/** The run's effects so far, told the adapter (each telling has them all; its last is the run's). */
export function tellEffects(): void {
	if (effects.size > 0) {
		post({ "type": "effects", "effects": [...effects.values()].map((effect) => ({ ...effect })) });
	}
}

/** What ends a probe's fork at the call — uncatchable, so the guest's own try/catch can't swallow it. */
const PROBED = Object.assign(new Error("probe: the call reached"), { [UNCATCHABLE]: true });

/** Each stop's probed resource, by machine and place (`file:line`): a stop asks more than once. */
const probed = new WeakMap<Vm, Map<string, string | undefined>>();

/**
 * The resource a capability call on `line` reaches, when its argument is computed on the line itself
 * (`path.join(dir, name)`, a template): the machine forked at the stop and stepped until the call — its arguments
 * evaluated as the run will evaluate them, every capability call on the way its inert stand-in, the event loop
 * deterministic — then thrown away. Undefined if the fork doesn't get there (it threw first, or took too long).
 */
export function probeResource(vm: Vm, place: Place, capability: string): string | undefined {
	const known = probed.get(vm);
	const key = `${place.file}:${place.line}`;

	if (known?.has(key) === true) {
		return known.get(key);
	}

	const fork = vm.fork();
	let resource: string | undefined;

	fork.breakpoints.clear();
	state.probing = { "capability": capability };

	try {
		for (let steps = 0; steps < 20_000 && !fork.finished && !fork.idle && state.probing.resource === undefined; steps += 1) {
			fork.step();
		}
	} catch {
		// PROBED (the call reached), or the fork threw before it: either way, what was found is what there is.
	} finally {
		({ resource } = state.probing);
		state.probing = undefined;
	}

	probed.set(vm, (known ?? new Map()).set(key, resource));

	return resource;
}

/** Every function in `holders`' values, `depth` levels down. */
export function functionsIn(holders: Record<string, unknown>[], depth = 2): WeakSet<object> {
	const found = new WeakSet<object>();
	const seen = new Set<unknown>();
	const visit = (value: unknown, left: number): void => {
		if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) {
			return;
		}

		seen.add(value);

		if (typeof value === "function") {
			found.add(value);
		}

		if (left > 0) {
			for (const key of Object.keys(value)) {
				try {
					visit((value as Record<string, unknown>)[key], left - 1);
				} catch { /* a getter that throws: nothing of the program's there */ }
			}
		}
	};

	for (const holder of holders) {
		for (const value of Object.values(holder)) {
			visit(value, depth);
		}
	}

	return found;
}

/** Each stop's line, as lineReaches found it, by machine and call. */
const linesReached = new WeakMap<Vm, Map<ts.CallExpression, boolean | undefined>>();

/**
 * Whether `call` — the capability-shaped call a stop at `place` is for — is a call of one of the program's own
 * built-ins (programFunctions): a fork run to it, whose host guard sees the callee as it's about to be called and ends
 * the fork there, so nothing on the line happens twice (a package's objects aren't forked). A call that only looks like
 * one — `fs.mkdir` on a package's own `fs` (zen-fs's in-memory one), a canary's stand-ins — reaches nothing of the
 * program's, and isn't a stop: what a package itself reaches, it reaches through node:fs, where the package gate decides.
 * The fork stops where the line does: a line done without the guard seeing the call made it of a guest function (the
 * program's own code: not a built-in either). Undefined when the fork can't say (the line threw, or ran too long).
 */
export function lineReaches(vm: Vm, place: Place, call: ts.CallExpression): boolean | undefined {
	const known = linesReached.get(vm) ?? new Map<ts.CallExpression, boolean | undefined>();

	linesReached.set(vm, known);

	if (known.has(call)) {
		return known.get(call);
	}

	const fork = vm.fork() as Vm & { "hostGuard"?: HostGuard };
	const depth = vm.frames.length;
	const outer = (vm as Vm & { "hostGuard"?: HostGuard }).hostGuard;
	let reached: boolean | undefined;

	fork.breakpoints.clear();
	fork.hostGuard = {
		...outer,
		"beforeCall": (callee, thisArg, isConstruct, site) => {
			if (site.node === call) {
				reached = state.programFunctions.has(callee);

				throw PROBED;
			}

			return outer?.beforeCall?.(callee, thisArg, isConstruct, site) ?? callee;
		}
	};
	// (stand-ins called on the way are their inert selves, as on any probe's fork)
	state.probing = { "capability": "" };

	try {
		// (the guard ends it at the call, by throwing)
		for (let steps = 0; steps < 20_000 && !fork.finished && !fork.idle; steps += 1) {
			fork.step();

			const here = placeOf(fork);

			if (fork.finished || fork.idle || fork.frames.length < depth || (fork.frames.length === depth && (here?.file !== place.file || here.line !== place.line))) {
				// (the line done, and the call — if it was made — never a host function's)
				reached ??= false;

				break;
			}
		}
	} catch {
		// PROBED (the call reached), or the line threw first: either way, what was found is what there is.
	} finally {
		state.probing = undefined;
	}

	known.set(call, reached);

	return reached;
}

export function capabilitySurface(fileName: string, args: string[], real?: Runtime, where: { "cwd"?: string; "env"?: Record<string, string> } = {}): { "globals": Record<string, unknown>; "modules": Record<string, unknown> } {
	const standins = gated(capabilityStandins(), real, where.cwd ?? "/workspace");
	// What a script reads of its process: its arguments (a run's inputs), the directory it was started in and its
	// environment (a terminal's — RUNNING.md, *Output goes where it was started*), and its stdin — nothing it can do.
	// (Its version is the one almostnode's process reports, packages/almostnode/shims/process.ts, so a run reads the same
	// version whichever runtime it's in.)
	// And how it ends: `exit(code)` there and then, or `exitCode` once it's done, as node's.
	const process = {
		"argv": ["node", fileName, ...args],
		"env": { ...where.env },
		"platform": "browser",
		"version": "v20.0.0",
		"versions": { "node": "20.0.0" },
		"cwd": () => where.cwd ?? "/workspace",
		"stdin": stdin,
		"exitCode": undefined as number | undefined,
		"exit": (code?: number): never => {
			throw Object.assign(new Error(`process.exit(${String(code ?? process.exitCode ?? 0)})`), { [UNCATCHABLE]: true, [EXITED]: code ?? process.exitCode ?? 0 });
		}
	};

	state.guestProcess = process;

	return { "globals": { ...standins.globals, "console": guestConsole(), "process": process }, "modules": standins.modules };
}

/** What a capability call's argument names: a path, or a URL's href — else undefined. */
function pathOrUrl(argument: unknown): string | undefined {
	if (typeof argument === "string") {
		return argument;
	}

	return argument instanceof URL ? argument.href : undefined;
}

/** The resource a capability call reaches, by its argument: a path, a URL, a request's url — else none (""). */
export function reachedBy(argument: unknown): string {
	const named = pathOrUrl(argument);

	if (named !== undefined) {
		return named;
	}

	if (typeof argument === "object" && argument !== null && "url" in argument) {
		const { url } = argument as { "url": string | URL };

		return String(url);
	}

	// http.request's options: where they reach
	if (typeof argument === "object" && argument !== null && ("hostname" in argument || "host" in argument)) {
		const { protocol = "http:", hostname, host, port, path = "" } = argument as { "protocol"?: string; "hostname"?: string; "host"?: string; "port"?: number | string; "path"?: string };

		return `${protocol}//${hostname ?? host}${port === undefined ? "" : ":" + String(port)}${path}`;
	}

	return "";
}

/** A call on a probe's fork (probeResource): the one it's after records what it reaches and ends the fork; any other is
 *  its inert self. */
function probeCall(probe: NonNullable<typeof state.probing>, fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]): unknown {
	const tagged = standinCapability(fn);

	if (tagged?.capability === probe.capability) {
		probe.resource = pathOrUrl(args[tagged.resourceArg]);

		throw PROBED;
	}

	return fn.apply(self, args);
}

/** A call's arguments as it's made: a relative path the program's directory's (`cwd`), as node resolves it. */
function madeArgs(capability: string, args: unknown[], resourceArg: number, cwd: string): unknown[] {
	const argument = args[resourceArg];

	return capability.startsWith("fs:") && typeof argument === "string" && !argument.startsWith("/") ? args.map((each, index) => (index === resourceArg ? `${cwd}/${argument}` : each)) : args;
}

/** Whether a call on `path` is on a workspace file — one the editor makes, and keeps among the run's effects itself. */
function editorKeeps(capability: string, path: unknown): boolean {
	return capability.startsWith("fs:") && typeof path === "string" && (path === "/workspace" || path.startsWith("/workspace/"));
}

/** The program's capabilities (RUNNING.md, *Effects are real, decided per call*): its `fs`, `child_process` and
 *  `fetch`, each gated call decided as it's made — a probe's fork gets the stand-in; a call the user denied at its stop
 *  (`denyNext`) fails with node's EACCES; a call a rule gives the result of (RUNNING.md, *A call's result*), or the
 *  user gave it at the stop (`giveNext`), gets that; a call the policy allows, or the user allowed at its stop
 *  (`allowNext`), happens for real through almostnode (`real`) — what it read recorded — and any other fails as a
 *  denied one would. With no `real` (exploring orderings: a run many times over), every call is its inert stand-in, as
 *  before. A module's other members are almostnode's own. (A module object shared under several names stays one
 *  object.) */
function gated(standins: ReturnType<typeof capabilityStandins>, real?: Runtime, cwd = "/workspace"): ReturnType<typeof capabilityStandins> {
	const wrapped = new Map<unknown, unknown>();
	const programFs = real === undefined ? undefined : state.programFsFor?.(cwd);

	// (only a run that can make calls has effects to tell: exploring orderings, every call is its stand-in)
	tallying = real !== undefined;
	const gate = (fn: (...args: unknown[]) => unknown, effect?: (...args: unknown[]) => unknown) => function(this: unknown, ...args: unknown[]): unknown {
		// A probe's fork (probeResource): the call it's after records what it reaches, and ends the fork there; any other
		// call on the way is its inert self — neither touches what the run itself was given (denyNext, giveNext).
		if (state.probing !== undefined) {
			return probeCall(state.probing, fn, this, args);
		}

		const tagged = standinCapability(fn);

		if (tagged === undefined) {
			return fn.apply(this, args);
		}

		// (made, refused or stood in for, it's an effect of each call it's in)
		state.evaluating?.impure("effect", tagged.capability);

		const argument = args[tagged.resourceArg];
		const resource = reachedBy(argument);
		// How it's decided: the person's answer at its stop, when it was stopped at — else the policy.
		const decided: Effect["decided"] = state.answeredNext ?? "policy";

		state.answeredNext = undefined;

		const denied = (why: string): never => {
			tally(tagged.capability, resource, "denied", undefined, decided);

			throw Object.assign(new Error(why), { "code": "EACCES" });
		};

		if (state.denyNext) {
			state.denyNext = false;
			denied("EACCES: permission denied (denied at its capability stop)");
		}

		const given = state.giveNext ?? (state.policy === undefined ? undefined : givenResult(state.policy, { "trigger": triggerOf(false), "capability": tagged.capability, "resource": resource }));

		state.giveNext = undefined;

		if (given !== undefined) {
			tally(tagged.capability, resource, "given", undefined, decided);

			return givenAs(tagged.capability, fn.apply(this, args), given.value);
		}

		if (state.skipNext) {
			state.skipNext = false;

			return skipped(tagged.capability, resource, fn.apply(this, args), decided);
		}

		if (effect === undefined) {
			return fn.apply(this, args);
		}

		// A copy's or a rename's other path, where it lands, is decided too. Its stop asked about its first path the policy
		// gates — its source, when that's gated — so the answer there is this path's only when the source wasn't; else the
		// policy alone decides it, and a call it won't let land isn't made.
		const landing = tagged.landing === undefined ? undefined : { "capability": tagged.landing, "resource": reachedBy(args[1]) };

		if (landing !== undefined) {
			const askedHere = state.allowNext && verdictOf(state.policy, tagged.capability, resource) === "allow";
			const landingVerdict = askedHere ? "allow" : verdictOf(state.policy, landing.capability, landing.resource);

			if (askedHere) {
				state.allowNext = false;
			}

			if (landingVerdict === "skip") {
				return skipped(landing.capability, landing.resource, fn.apply(this, args), "policy");
			}

			if (landingVerdict === "deny") {
				tally(landing.capability, landing.resource, "denied", undefined, "policy");

				throw Object.assign(new Error(`EACCES: permission denied — ${landing.capability} ${landing.resource} isn't allowed (the policy decides it, and it wasn't asked)`), { "code": "EACCES" });
			}
		}

		// Skipped by the policy (not made, the run going on — as at its stop), made, or refused — as any debugger's calls
		// through the runtime's files are (gate.ts).
		const verdict = verdictOf(state.policy, tagged.capability, resource);

		if (verdict === "skip") {
			return skipped(tagged.capability, resource, fn.apply(this, args), decided);
		}

		if (verdict === "deny" && !state.allowNext) {
			denied(`EACCES: permission denied — ${tagged.capability} ${resource} isn't allowed (the policy decides it, and it wasn't asked)`);
		}

		if (verdict === "deny") {
			state.allowNext = false;
		}

		// A relative path is the program's directory's (its process.cwd(): a terminal's), as node resolves it — where a copy
		// lands too.
		const made = madeArgs(tagged.capability, landing === undefined ? args : madeArgs(landing.capability, args, 1, cwd), tagged.resourceArg, cwd);

		// (a workspace file's call the editor makes, and keeps among the run's effects itself)
		if (!(programFs !== undefined && editorKeeps(tagged.capability, made[tagged.resourceArg]))) {
			tally(tagged.capability, resource, "made", undefined, decided);
		}

		if (landing !== undefined && !(programFs !== undefined && editorKeeps(landing.capability, made[1]))) {
			tally(landing.capability, landing.resource, "made", undefined, decided);
		}

		return madeFor(() => effect(...made));
	};

	// almostnode's own module (or the network) a stand-in module stands for: its members, the gated ones made real.
	const realOf = (key: string): Record<string, unknown> | undefined => {
		if (real === undefined) {
			return undefined;
		}

		const id = key.replace(/^node:/u, "");

		// The program's `fs`: its workspace files through the editor.
		if (programFs !== undefined && (id === "fs" || id === "fs/promises")) {
			return (id === "fs" ? programFs : programFs.promises) as unknown as Record<string, unknown>;
		}

		return (id === "fs/promises" ? (real.require("fs", "/workspace", "package") as { "promises": Record<string, unknown> }).promises : real.require(id, "/workspace", "package")) as Record<string, unknown>;
	};

	const wrap = (value: unknown, key: string): unknown => {
		if (wrapped.has(value)) {
			return wrapped.get(value);
		}

		let made: unknown;

		if (typeof value === "function") {
			made = gate(value as (...args: unknown[]) => unknown, real !== undefined && key === "fetch" ? (...args: unknown[]) => (fetch as (...fetchArgs: unknown[]) => unknown)(...args) : undefined);
		} else if (typeof value === "object" && value !== null) {
			const module = realOf(key);
			const effectOf = (name: string): ((...args: unknown[]) => unknown) | undefined => {
				const member = module?.[name];

				return typeof member === "function" ? (...args: unknown[]) => (member as (...memberArgs: unknown[]) => unknown).apply(module, args) : undefined;
			};

			made = { ...module, ...Object.fromEntries(Object.entries(value).map(([name, member]) => [name, typeof member === "function" ? gate(member as (...args: unknown[]) => unknown, effectOf(name)) : member])) };
		} else {
			made = value;
		}

		wrapped.set(value, made);

		return made;
	};

	return { "globals": Object.fromEntries(Object.entries(standins.globals).map(([key, value]) => [key, wrap(value, key)])), "modules": Object.fromEntries(Object.entries(standins.modules).map(([key, value]) => [key, wrap(value, key)])) };
}

/** Make `call` — a program's capability call, allowed — for real: a write let through the runtime's refusal while it's
 *  made. */
function madeFor(call: () => unknown): unknown {
	state.allowingWrites += 1;

	let result: unknown;

	try {
		result = call();
	} finally {
		state.allowingWrites -= 1;
	}

	return result;
}

/** A call that wasn't made (skipped: at its stop, or by the policy) — its stand-in's `result` — told on its line, as a
 *  counted among the run's effects. */
function skipped(capability: string, resource: string, result: unknown, decided?: Effect["decided"]): unknown {
	tally(capability, resource, "skipped", undefined, decided);

	return result;
}

/** Whether `place` is a capability call the policy gated when it was armed. */
export const capabilityAt = (place: Place): boolean => state.capabilityLines.get(place.file)?.has(place.line) === true;

/** The host functions the run's own code is given that this worker watches (tsval's `watches`): its console's, and its
 *  capability stand-ins — it tells their effects (`impure`). */
export function watchedOf(...holders: Record<string, unknown>[]): WeakSet<object> {
	const watched = new WeakSet<object>();

	for (const value of holders.flatMap((holder) => Object.values(holder))) {
		if (typeof value === "function") {
			watched.add(value);
		} else if (value !== null && typeof value === "object") {
			Object.values(value).filter((each) => typeof each === "function").forEach((each) => watched.add(each as object));
		}
	}

	return watched;
}

/** Arm the capability calls in `file` the policy gates as lines a run stops at, to ask there (RUNTIME-EVIDENCE.md,
 *  *Capability decisions, on the line*); with no policy, none. */
export function armCapabilities(file: ts.SourceFile): void {
	state.capabilityLines.set(file.fileName, new Set(state.policy === undefined ? [] : capabilityBreakLines(file, state.policy)));
}
