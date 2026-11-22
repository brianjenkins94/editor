import type { LoadedPackage, Effect } from "@brianjenkins94/editor-api";
import type { RuntimeDecision, RuntimeVerdict, AskedWhy } from "@brianjenkins94/editor-api/runtime";
import { FS_SYNC, FS_ASYNC, FS_DESTINATION } from "@brianjenkins94/almostnode/fs-capabilities";
import { verdictOf } from "@brianjenkins94/editor-api/gate";
import { settledReach, covers } from "@brianjenkins94/util/silo/evidence";
import { packageDisposition } from "@brianjenkins94/util/silo/policy";
import { reachedBy, tally } from "./gate";
import { keptText } from "./install";
import { state } from "./state";

export const packagesRan = new Map<string, LoadedPackage>();

const PACKAGE_CALLS: Record<string, Record<string, string>> = {
	"fs": Object.fromEntries([...Object.entries(FS_SYNC), ...Object.entries(FS_ASYNC)].map(([method, op]) => [method, "fs:" + op])),
	"fs/promises": Object.fromEntries(Object.entries(FS_ASYNC).map(([method, op]) => [method, "fs:" + op])),
	"child_process": Object.fromEntries(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"].map((method) => [method, "exec"])),
	"http": { "request": "net", "get": "net" },
	"https": { "request": "net", "get": "net" }
};

const refused = (error: unknown): boolean => ["EACCES", "EPERM", "ENOSYS"].includes((error as { "code"?: unknown } | undefined)?.code as string);

const packageBuiltins = new Map<string, unknown>();

export function packageOf(dir: string): string {
	const ran = packageIn(dir);

	return ran.version === undefined ? ran.name : `${ran.name}@${ran.version}`;
}

export function readBaseline(): typeof state.baseline {
	try {
		return JSON.parse(keptText("baseline.json")) as typeof state.baseline;
	} catch {
		return undefined;
	}
}

function packageIn(dir: string): { "name": string; "version"?: string } {
	return packagesRan.get(dir) ?? { "name": dir.slice(dir.lastIndexOf("/node_modules/") + "/node_modules/".length) };
}

function packageVerdict(dir: string, capability: string, call: Omit<RuntimeDecision, "package">): RuntimeVerdict {
	const pkg = packageIn(dir);

	if (state.policy !== undefined && packageDisposition(state.policy, pkg) === "allow") {
		return { "allow": true, "decided": "policy" };
	}

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

function askedWhy(pkg: { "name": string; "version"?: string }, capability: string): AskedWhy {
	if (state.baseline === undefined) {
		return { "reason": "no-baseline" };
	}

	const recorded = state.baseline.packages?.[pkg.name]?.version;

	if (recorded !== undefined && pkg.version !== undefined && recorded !== pkg.version) {
		return { "reason": "other-version", "recorded": recorded };
	}

	const whole = state.baseline.packages?.[pkg.name];

	if (whole === undefined) {
		return { "reason": "unread" };
	}

	const uses = Object.values(state.baseline.consumer ?? {}).flatMap((workspace) => Object.entries(workspace).filter(([spec, entry]) => entry.kind === "package" && (spec === pkg.name || spec.startsWith(pkg.name + "/"))).map(([, entry]) => entry));
	const entries: { "grew"?: Record<string, string> }[] = uses.length > 0 ? uses : [whole];

	for (const entry of entries) {
		for (const [grown, origin] of Object.entries(entry.grew ?? {})) {
			if (covers([grown], capability)) {
				return { "reason": "grew", "by": /^\d/u.test(origin) ? "version" : "code", "origin": origin };
			}
		}
	}

	return { "reason": "unpredicted" };
}

const packageFetches = new Map<string, typeof fetch>();

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

					const landingOp = kind === "fs" ? FS_DESTINATION[property as string] : undefined;
					const landing = landingOp === undefined ? undefined : { "capability": "fs:" + landingOp, "resource": reachedBy(args[1]) };
					const landed = landing === undefined ? undefined : packageVerdict(dir, landing.capability, { "kind": "fs", "method": property as string, "op": landingOp, "args": [landing.resource] });

					if (landing !== undefined && landed?.allow !== true) {
						tally(landing.capability, landing.resource, "denied", pkg, landed?.decided);

						throw Object.assign(new Error(`EACCES: ${pkg} may not ${landing.capability} ${landing.resource} (${landed?.decided === "policy" ? "the policy" : "refused at the call"})`), { "code": "EACCES" });
					}

					const writing = verdict.allow && (capability === "fs:write" || landing !== undefined);
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
