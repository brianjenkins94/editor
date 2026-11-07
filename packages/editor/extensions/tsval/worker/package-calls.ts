/**
 * A package's calls, decided at the call (ARCHITECTURE.md, *Capabilities*): within its baseline, made; else the
 * policy, then the editor — each package's own `fs`, `child_process` and `fetch`, counted as that package's.
 */
import type { LoadedPackage, Effect } from "@brianjenkins94/editor-api";
import type { RuntimeDecision, RuntimeVerdict, AskedWhy } from "@brianjenkins94/editor-api/runtime";
import { FS_SYNC, FS_ASYNC, FS_DESTINATION } from "@brianjenkins94/almostnode/fs-capabilities";
import { verdictOf } from "@brianjenkins94/editor-api/gate";
import { settledReach, covers } from "@brianjenkins94/util/silo/evidence";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import { reachedBy, tally } from "./gate";
import { keptText } from "./install";
import { state } from "./state";

/** The packages whose code the run ran (almostnode tells each as its first module runs), by folder: told with its
 *  coverage, for its envelope (whether anyone ran a version later found compromised). */
export const packagesRan = new Map<string, LoadedPackage>();

/** What a package's call through its `fs` or `child_process` is: each method by its capability. */
const PACKAGE_CALLS: Record<string, Record<string, string>> = {
	"fs": Object.fromEntries([...Object.entries(FS_SYNC), ...Object.entries(FS_ASYNC)].map(([method, op]) => [method, "fs:" + op])),
	"fs/promises": Object.fromEntries(Object.entries(FS_ASYNC).map(([method, op]) => [method, "fs:" + op])),
	"child_process": Object.fromEntries(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"].map((method) => [method, "exec"])),
	// (almostnode's http and https reach the network through the global fetch — counted here as the package's, by URL)
	"http": { "request": "net", "get": "net" },
	"https": { "request": "net", "get": "net" }
};

/** A call that didn't happen because it may not: refused (a write: beforeFs), or not possible here (a command). */
const refused = (error: unknown): boolean => ["EACCES", "EPERM", "ENOSYS"].includes((error as { "code"?: unknown } | undefined)?.code as string);

/** Each package's own `fs`, `fs/promises` and `child_process`, by module and package folder. */
const packageBuiltins = new Map<string, unknown>();

/** The package installed in `dir`, as an effect names it: name@version (packagesRan), or its folder's name. */
export function packageOf(dir: string): string {
	const ran = packageIn(dir);

	return ran.version === undefined ? ran.name : `${ran.name}@${ran.version}`;
}

/** The baseline as it is now, through the editor's runtime (read as the debugger's own: neither decided nor counted). */
export function readBaseline(): typeof state.baseline {
	try {
		return JSON.parse(keptText("baseline.json")) as typeof state.baseline;
	} catch {
		return undefined;
	}
}

/** The package installed in `dir`, by name and version (packagesRan). */
function packageIn(dir: string): { "name": string; "version"?: string } {
	return packagesRan.get(dir) ?? { "name": dir.slice(dir.lastIndexOf("/node_modules/") + "/node_modules/".length) };
}

/**
 * How the package in `dir` calling `capability` goes: trusted by the policy (an org's contract, say) — made, no question;
 * within what its baseline settled of the version that runs — the join of the code's use of it (what the members it
 * imports reach), else the whole package's — made (the baseline spot-checked at the call: an entry of another version
 * says nothing of this one); else the policy decides, at the call — redline, the policy, then the
 * person, asked, blocking until it's answered (the editor's decide). Where nobody can be asked — no editor, a failure
 * to decide — the policy decides alone, a call it would ask about refused. Every
 * call is counted with how it was decided.
 */
function packageVerdict(dir: string, capability: string, call: Omit<RuntimeDecision, "package">): RuntimeVerdict {
	const pkg = packageIn(dir);

	if (state.policy !== undefined && packageDisposition(state.policy, pkg) === "allow") {
		return { "allow": true, "decided": "policy" };
	}

	// (spot-checked: the baseline's version of the package is the one that runs; then what it settled — the join of the
	// code's use of it, else, for a package only a dependency uses, the whole package's)
	const recorded = state.baseline?.packages?.[pkg.name]?.version;
	const reach = state.baseline === undefined || (recorded !== undefined && pkg.version !== undefined && recorded !== pkg.version) ? undefined : settledReach(state.baseline, pkg.name);

	if (reach !== undefined && covers(reach, capability)) {
		return { "allow": true, "decided": "baseline" };
	}

	const alone = (): RuntimeVerdict => ({ "allow": verdictOf(state.policy, capability, call.args[0] ?? "", state.live) === "allow", "decided": "policy" });

	if (state.live || state.editorLink === undefined) {
		return alone();
	}

	try {
		return state.editorLink.decide({ ...call, "package": packageOf(dir), "why": askedWhy(pkg, capability) });
	} catch {
		return alone();
	}
}

/** Why `pkg`'s call of `capability` is asked about, from what the baseline says of it — said at the prompt, so whoever
 *  answers knows whether the package changed, the code's use of it did, or the analysis missed the call. */
function askedWhy(pkg: { "name": string; "version"?: string }, capability: string): AskedWhy {
	if (state.baseline === undefined) {
		return { "reason": "no-baseline" };
	}

	const recorded = state.baseline.packages?.[pkg.name]?.version;

	if (recorded !== undefined && pkg.version !== undefined && recorded !== pkg.version) {
		return { "reason": "other-version", "recorded": recorded };
	}

	const whole = state.baseline.packages?.[pkg.name];

	// (never read: not a dependency, or one that couldn't be — the code's use of it has no join, only its members)
	if (whole === undefined) {
		return { "reason": "unread" };
	}

	// (what the gate decided against: the code's use of it, else, for a package only a dependency uses, the whole package)
	const uses = Object.values(state.baseline.consumer ?? {}).flatMap((workspace) => Object.entries(workspace).filter(([spec, entry]) => entry.kind === "package" && (spec === pkg.name || spec.startsWith(pkg.name + "/"))).map(([, entry]) => entry));
	const entries: { "grew"?: Record<string, string> }[] = uses.length > 0 ? uses : [whole];

	for (const entry of entries) {
		for (const [grown, origin] of Object.entries(entry.grew ?? {})) {
			if (covers([grown], capability)) {
				// (a version's origin is the version; the code's, the members it started using, or `*`)
				return { "reason": "grew", "by": /^\d/u.test(origin) ? "version" : "code", "origin": origin };
			}
		}
	}

	return { "reason": "unpredicted" };
}

/** Each package's own `fetch`, by package folder. */
const packageFetches = new Map<string, typeof fetch>();

/**
 * The package whose module is in folder `from` gets the real `fetch`, each call decided (packageVerdict) and counted among
 * the run's effects as that package's (`net`, by URL), as its fs and child_process calls are (packageBuiltin). A package
 * that reaches for `globalThis.fetch` itself isn't told apart. Undefined for anything that isn't a package's.
 */
export function packageFetch(from: string): typeof fetch | undefined {
	const dir = state.packageDirOf?.(from);

	if (dir === undefined) {
		return undefined;
	}

	if (!packageFetches.has(dir)) {
		packageFetches.set(dir, async (input, init) => {
			const resource = reachedBy(input);
			const verdict = packageVerdict(dir, "net", { "kind": "net", "args": [resource] });

			if (!verdict.allow) {
				tally("net", resource, "denied", packageOf(dir), verdict.decided);

				throw Object.assign(new TypeError(`EACCES: ${packageOf(dir)} may not reach ${resource} (${verdict.decided === "policy" ? "the policy" : "refused at the call"})`), { "code": "EACCES" });
			}

			tally("net", resource, "made", packageOf(dir), verdict.decided);

			return globalThis.fetch(input, init);
		});
	}

	return packageFetches.get(dir);
}

/**
 * The package asking from folder `from` gets almostnode's own `id` — what it does is what it did — with each gated call
 * counted among the run's effects as that package's, by name@version (packagesRan): a read made, a write refused
 * (beforeFs), a command not possible here. Undefined for anything else (the program's code, a module with no gated calls).
 */
export function packageBuiltin(id: string, from: string): unknown {
	const calls = PACKAGE_CALLS[id];
	const dir = calls === undefined ? undefined : state.packageDirOf?.(from);

	if (calls === undefined || dir === undefined || state.runtime === undefined) {
		return undefined;
	}

	const key = id + "\0" + dir;

	if (!packageBuiltins.has(key)) {
		const pkg = packageOf(dir);
		const real = state.runtime.require(id, "/workspace", "package") as Record<string, unknown>;
		const counted = (methods: Record<string, string>, target: Record<string, unknown>): Record<string, unknown> => new Proxy(target, {
			"get": (object, property, receiver) => {
				const value = Reflect.get(object, property, receiver) as unknown;

				// fs.promises: the same, its methods the async ones
				if (property === "promises" && id === "fs" && typeof value === "object" && value !== null) {
					return counted(PACKAGE_CALLS["fs/promises"], value as Record<string, unknown>);
				}

				const capability = typeof property === "string" && typeof value === "function" ? methods[property] : undefined;

				if (capability === undefined) {
					return value;
				}

				return function(this: unknown, ...args: unknown[]): unknown {
					const resource = reachedBy(args[0]);
					let kind: RuntimeDecision["kind"] = "net";

					if (capability.startsWith("fs:")) {
						kind = "fs";
					} else if (capability === "exec") {
						kind = "exec";
					}

					const verdict = packageVerdict(dir, capability, { "kind": kind, "method": property as string, ...kind === "fs" ? { "op": capability === "fs:write" ? "write" : "read" } : {}, "args": [resource] });

					if (!verdict.allow) {
						tally(capability, resource, "denied", pkg, verdict.decided);

						throw Object.assign(new Error(`EACCES: ${pkg} may not ${capability} ${resource} (${verdict.decided === "policy" ? "the policy" : "refused at the call"})`), { "code": "EACCES" });
					}

					// A copy's or a rename's other path, where it lands: decided as its first is.
					const landingOp = kind === "fs" ? FS_DESTINATION[property as string] : undefined;
					const landing = landingOp === undefined ? undefined : { "capability": "fs:" + landingOp, "resource": reachedBy(args[1]) };
					const landed = landing === undefined ? undefined : packageVerdict(dir, landing.capability, { "kind": "fs", "method": property as string, "op": landingOp, "args": [landing.resource] });

					if (landing !== undefined && landed?.allow !== true) {
						tally(landing.capability, landing.resource, "denied", pkg, landed?.decided);

						throw Object.assign(new Error(`EACCES: ${pkg} may not ${landing.capability} ${landing.resource} (${landed?.decided === "policy" ? "the policy" : "refused at the call"})`), { "code": "EACCES" });
					}

					// (a write decided here is let through the runtime's guard, as a program's allowed one is: madeFor)
					const writing = verdict.allow && (capability === "fs:write" || landing !== undefined);
					// (what came of it, told of each path it reached)
					const told = (how: Effect["how"]): void => {
						tally(capability, resource, how, pkg, verdict.decided);

						if (landing !== undefined) {
							tally(landing.capability, landing.resource, how, pkg, landed?.decided);
						}
					};

					if (writing) {
						state.allowingWrites += 1;
					}

					try {
						const result = (value as (...rest: unknown[]) => unknown).apply(this, args);

						if (typeof (result as { "then"?: unknown } | null)?.then === "function") {
							return (result as Promise<unknown>).then((settled) => {
								told("made");

								return settled;
							}, (error: unknown) => {
								told(refused(error) ? "denied" : "made");

								throw error;
							});
						}

						told("made");

						return result;
					} catch (error) {
						told(refused(error) ? "denied" : "made");

						throw error;
					} finally {
						if (writing) {
							state.allowingWrites -= 1;
						}
					}
				};
			}
		});

		packageBuiltins.set(key, counted(calls, real));
	}

	return packageBuiltins.get(key);
}
