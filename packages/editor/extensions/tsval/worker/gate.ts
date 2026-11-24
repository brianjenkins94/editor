import type { Effect } from "@brianjenkins94/editor-api";
import type { HostGuard } from "@brianjenkins94/tsval";
import type { Runtime } from "./runtime";
import type { Place, Vm } from "./state";
import { policySkips, recordingKey, requestOf, triggerOf, verdictOf } from "@brianjenkins94/editor-api/gate";
import { UNCATCHABLE } from "@brianjenkins94/tsval";
import { givenResult } from "@brianjenkins94/util/silo/policy";
import ts from "typescript";
import { capabilityBreakLines } from "../capability-calls";
import { capabilityStandins, standinCapability, givenAs } from "../canary";
import { answerLocally } from "./loopback";
import { EXITED, stdin } from "./process";
import { guestConsole, guestStream, placeOf } from "./session";
import { post, state } from "./state";
import { testsEffects } from "./tests";
import { tellReplayed, tellSkipped } from "./values";

const effects = new Map<string, Effect>();

let tallying = false;

export function tally(capability: string, resource: string, how: Effect["how"], pkg?: string, decided?: Effect["decided"], ofRun = true): void {
	if (pkg !== undefined) {
		state.evaluating?.impure("effect", capability);
	}

	if (!tallying) {
		return;
	}

	const key = `${how}\0${capability}\0${resource}\0${pkg ?? ""}\0${decided ?? ""}`;
	const effect = (): Effect => ({ "capability": capability, "resource": resource, "how": how, "calls": 0, ...pkg === undefined ? {} : { "package": pkg }, ...decided === undefined ? {} : { "decided": decided } });

	for (const tallied of [...ofRun ? [effects] : [], ...testsEffects()]) {
		const known = tallied.get(key) ?? effect();

		known.calls += 1;
		tallied.set(key, known);
	}
}

export function tellEffects(): void {
	if (effects.size > 0) {
		post({ "type": "effects", "effects": [...effects.values()].map((effect) => ({ ...effect })) });
	}
}

const PROBED = Object.assign(new Error("probe: the call reached"), { [UNCATCHABLE]: true });

const probed = new WeakMap<Vm, Map<string, string | undefined>>();

export function probeResource(vm: Vm, place: Place, capability: string, argIndex = 0): string | undefined {
	const known = probed.get(vm);
	const key = `${place.file}:${place.line}:${capability}:${String(argIndex)}`;

	if (known?.has(key) === true) {
		return known.get(key);
	}

	const fork = vm.fork();
	let resource: string | undefined;

	fork.breakpoints.clear();
	state.probing = { "capability": capability, "argIndex": argIndex };

	try {
		for (let steps = 0; steps < 20_000 && !fork.finished && !fork.idle && state.probing.resource === undefined; steps += 1) {
			fork.step();
		}
	} catch {
	} finally {
		({ resource } = state.probing);
		state.probing = undefined;
	}

	probed.set(vm, (known ?? new Map()).set(key, resource));

	return resource;
}

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

const linesReached = new WeakMap<Vm, Map<ts.CallExpression, boolean | undefined>>();

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
	state.probing = { "capability": "" };

	try {
		for (let steps = 0; steps < 20_000 && !fork.finished && !fork.idle; steps += 1) {
			fork.step();

			const here = placeOf(fork);

			if (fork.finished || fork.idle || fork.frames.length < depth || (fork.frames.length === depth && (here?.file !== place.file || here.line !== place.line))) {
				reached ??= false;

				break;
			}
		}
	} catch {
	} finally {
		state.probing = undefined;
	}

	known.set(call, reached);

	return reached;
}

export function capabilitySurface(fileName: string, args: string[], real?: Runtime, where: { "cwd"?: string; "env"?: Record<string, string> } = {}): { "globals": Record<string, unknown>; "modules": Record<string, unknown> } {
	const standins = gated(capabilityStandins(), real, where.cwd ?? "/workspace");
	const process = {
		"argv": ["node", fileName, ...args],
		"stdout": guestStream("stdout"),
		"stderr": guestStream("stderr"),
		"getBuiltinModule": (id: string): unknown => (Object.hasOwn(standins.modules, id)
			? standins.modules[id]
			: (state.runtime?.getProcess() as unknown as { "getBuiltinModule"?: (id: string) => unknown } | undefined)?.getBuiltinModule?.(id)),
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

function pathOrUrl(argument: unknown): string | undefined {
	if (typeof argument === "string") {
		return argument;
	}

	return argument instanceof URL ? argument.href : undefined;
}

export function reachedBy(argument: unknown): string {
	const named = pathOrUrl(argument);

	if (named !== undefined) {
		return named;
	}

	if (typeof argument === "object" && argument !== null && "url" in argument) {
		const { url } = argument as { "url": string | URL };

		return String(url);
	}

	if (typeof argument === "object" && argument !== null && ("hostname" in argument || "host" in argument)) {
		const { protocol = "http:", hostname, host, port, path = "" } = argument as { "protocol"?: string; "hostname"?: string; "host"?: string; "port"?: number | string; "path"?: string };

		return `${protocol}//${hostname ?? host}${port === undefined ? "" : ":" + String(port)}${path}`;
	}

	return "";
}

function probeCall(probe: NonNullable<typeof state.probing>, fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]): unknown {
	const tagged = standinCapability(fn);

	if (tagged === undefined) {
		return fn.apply(self, args);
	}

	const argIndex = probe.argIndex ?? tagged.resourceArg;
	const after = argIndex === tagged.resourceArg ? tagged.capability : tagged.landing;

	if (after === probe.capability) {
		probe.resource = pathOrUrl(args[argIndex]);

		throw PROBED;
	}

	return fn.apply(self, args);
}

function madeArgs(capability: string, args: unknown[], resourceArg: number, cwd: string): unknown[] {
	const argument = args[resourceArg];

	return capability.startsWith("fs:") && typeof argument === "string" && !argument.startsWith("/") ? args.map((each, index) => (index === resourceArg ? `${cwd}/${argument}` : each)) : args;
}

function editorKeeps(capability: string, path: unknown): boolean {
	return capability.startsWith("fs:") && typeof path === "string" && (path === "/workspace" || path.startsWith("/workspace/"));
}

function gated(standins: ReturnType<typeof capabilityStandins>, real?: Runtime, cwd = "/workspace"): ReturnType<typeof capabilityStandins> {
	const wrapped = new Map<unknown, unknown>();
	const programFs = real === undefined ? undefined : state.programFsFor?.(cwd);

	tallying = real !== undefined;
	const gate = (fn: (...args: unknown[]) => unknown, effect?: (...args: unknown[]) => unknown) => function(this: unknown, ...args: unknown[]): unknown {
		if (state.probing !== undefined) {
			return probeCall(state.probing, fn, this, args);
		}

		const tagged = standinCapability(fn);

		if (tagged === undefined) {
			return fn.apply(this, args);
		}

		state.evaluating?.impure("effect", tagged.capability);

		const argument = args[tagged.resourceArg];
		const resource = reachedBy(argument);
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

		const given = state.giveNext ?? (state.policy === undefined ? undefined : givenResult(state.policy, { "trigger": triggerOf(state.live), "capability": tagged.capability, "resource": resource }));

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

		const landing = tagged.landing === undefined ? undefined : { "capability": tagged.landing, "resource": reachedBy(args[1]) };

		if (landing !== undefined) {
			const askedHere = state.allowNext && verdictOf(state.policy, tagged.capability, resource, state.live) === "allow";
			const landingVerdict = askedHere ? "allow" : verdictOf(state.policy, landing.capability, landing.resource, state.live);

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

		const verdict = verdictOf(state.policy, tagged.capability, resource, state.live);
		const canReplay = state.live && !policySkips(state.policy, tagged.capability, resource, true);
		const target = madeArgs(tagged.capability, args, tagged.resourceArg, cwd)[tagged.resourceArg];
		const intoLayer = verdict === "skip" && canReplay && state.runLayer !== undefined && programFs !== undefined && editorKeeps(tagged.capability, target) && (tagged.capability !== "fs:read" || state.runLayer.holds(String(target)));

		if (verdict === "skip" && !intoLayer) {
			const key = recordingKey(tagged.capability, resource, requestOf(tagged.capability, args));

			if (canReplay && Object.hasOwn(state.recordedResults, key)) {
				tally(tagged.capability, resource, "given", undefined, "recorded");
				tellReplayed(tagged.capability, resource);

				return givenAs(tagged.capability, fn.apply(this, args), state.recordedResults[key]);
			}

			return skipped(tagged.capability, resource, fn.apply(this, args), decided);
		}

		if (verdict === "deny" && !state.allowNext) {
			denied(`EACCES: permission denied — ${tagged.capability} ${resource} isn't allowed (the policy decides it, and it wasn't asked)`);
		}

		if (verdict === "deny") {
			state.allowNext = false;
		}

		const made = madeArgs(tagged.capability, landing === undefined ? args : madeArgs(landing.capability, args, 1, cwd), tagged.resourceArg, cwd);

		if (intoLayer) {
			tally(tagged.capability, resource, "made", undefined, "layer");
		} else {
			tally(tagged.capability, resource, "made", undefined, decided, !(programFs !== undefined && editorKeeps(tagged.capability, made[tagged.resourceArg])));
		}

		if (landing !== undefined) {
			tally(landing.capability, landing.resource, "made", undefined, decided, !(programFs !== undefined && editorKeeps(landing.capability, made[1])));
		}

		return madeFor(() => effect(...made), intoLayer ? undefined : { "capability": tagged.capability, "resource": resource, "request": requestOf(tagged.capability, args) });
	};

	const realOf = (key: string): Record<string, unknown> | undefined => {
		if (real === undefined) {
			return undefined;
		}

		const id = key.replace(/^node:/u, "");

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
			const gatedCall = gate(value as (...args: unknown[]) => unknown, real !== undefined && key === "fetch" ? (...args: unknown[]) => (fetch as (...fetchArgs: unknown[]) => unknown)(...args) : undefined);

			made = key === "fetch"
				? function(this: unknown, ...args: unknown[]): unknown {
					const local = state.local === undefined || state.probing !== undefined ? undefined : answerLocally(args[0], args[1] as RequestInit | undefined, state.local);

					return local ?? gatedCall.apply(this, args);
				}
				: gatedCall;
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

const RECORD_MAX = 256 * 1024;

function textOf(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	return value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
}

function madeFor(call: () => unknown, recording?: { "capability": string; "resource": string; "request"?: string }): unknown {
	const record = (value: unknown): void => {
		const text = textOf(value);

		if (recording !== undefined && text !== undefined && text !== "" && text.length <= RECORD_MAX) {
			post({ "type": "recorded", "capability": recording.capability, "resource": recording.resource, "value": text, ...recording.request === undefined ? {} : { "request": recording.request } });
		}
	};

	state.allowingWrites += 1;

	let result: unknown;

	try {
		result = call();
	} finally {
		state.allowingWrites -= 1;
	}

	if (recording?.capability === "net" && result instanceof Promise) {
		void result.then((response: unknown) => (response instanceof Response && response.ok ? response.clone().text().then(record) : undefined), () => undefined);
	} else if (recording?.capability === "fs:read") {
		if (result instanceof Promise) {
			void result.then(record, () => undefined);
		} else {
			record(result);
		}
	}

	return result;
}

function skipped(capability: string, resource: string, result: unknown, decided?: Effect["decided"]): unknown {
	tally(capability, resource, "skipped", undefined, decided);
	tellSkipped(capability, resource);

	return result;
}

export const capabilityAt = (place: Place): boolean => state.capabilityLines.get(place.file)?.has(place.line) === true;

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

export function armCapabilities(file: ts.SourceFile): void {
	state.capabilityLines.set(file.fileName, new Set(state.policy === undefined || state.live ? [] : capabilityBreakLines(file, state.policy)));
}
