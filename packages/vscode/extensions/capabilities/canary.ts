/**
 * Capabilities canary — the DYNAMIC half of the capability IDE (the middle column: concrete pre-call values).
 *
 * The static engine (engine.ts, util/silo `findReach`) captures a capability call's resource only when it's a
 * STATIC STRING LITERAL. The canary covers the rest: it RUNS the module in the tsval interpreter and, at the
 * host↔guest boundary, observes the CONCRETE argument each capability call is actually invoked with — the real
 * URL a `fetch(base + id)` builds, the path a computed `writeFile(dir + name)` writes. Read-only: capability
 * callables are inert stand-ins, so observing a run performs no real net/fs/exec effect (M0 observes; boxing /
 * tripwire is a later milestone).
 *
 * tsval's `HostGuard.beforeCall` is the seam: it fires just before the interpreter invokes a host callable, with
 * the call-expression node (→ source span, same anchor the static rows use) and the arguments AS EVALUATED. We
 * classify NOT by re-matching the AST (silo/reach does that, but it pulls oxc — too heavy for a tsval worker)
 * but by the IDENTITY of the invoked callable: the canary OWNS the capability surface it injects, so it tags each
 * stand-in with its capability. That also resolves aliasing for free (`const f = fetch; f(url)` still hits the
 * tagged `fetch`). Danger grading stays with silo policy (`isDangerous`, which is parser-free).
 *
 * M0 scope: CALL capabilities that execute during a normal module run (top-level, or reachable from one). `env`
 * is a member read (`process.env.KEY`) whose key is always a literal — the static half already resolves it — so
 * the canary skips it. Calls inside functions never invoked during the run are not observed (the nature of
 * dynamic analysis; a later milestone can drive entrypoints).
 */
import { createVM } from "@brianjenkins94/tsval";
import type { HostCallSite } from "@brianjenkins94/tsval";
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import ts from "typescript";

export interface CanaryObservation {
	/** Capability class (silo vocabulary): net / fs:read / fs:write / exec. */
	"capability": string;
	/** The call expression text (e.g. "fetch", "fs.writeFile"). */
	"callee": string;
	/** The concrete resource observed at the call — the first string argument, resolved at runtime. */
	"value": string;
	/** Whether a string resource was observed (false → the call ran but its resource wasn't a string arg). */
	"observed": boolean;
	/** The STATICALLY-known resource: the literal text when the resource argument is a string literal in the
	 *  source, else undefined (a concatenation / variable / computed value the static half can't resolve). This
	 *  is the panel's "static" column; `value` is its "runtime" column. When both are set and equal, the static
	 *  half already had it; when only `value` is set, the canary is what resolved it. */
	"static"?: string;
	/** Source span of the call, for anchoring to the document (same basis as the static rows). */
	"start": number;
	"end": number;
	/** Whether the capability is dangerous enough to gate (silo policy). */
	"dangerous": boolean;
}

/** Brand tagging an injected stand-in with the capability it stands for (read back in `beforeCall`). */
const CAPABILITY = Symbol("capabilities.canary.capability");
/** Which argument index carries the resource (URL / path / command). Default 0. */
const RESOURCE_ARG = Symbol("capabilities.canary.resourceArg");

type Tagged = ((...args: unknown[]) => unknown) & { [CAPABILITY]?: string; [RESOURCE_ARG]?: number };

/** Tag a stand-in with its capability (and optionally which arg is the resource). */
function tag<T extends (...args: never[]) => unknown>(capability: string, fn: T, resourceArg = 0): T {
	(fn as Tagged)[CAPABILITY] = capability;
	(fn as Tagged)[RESOURCE_ARG] = resourceArg;

	return fn;
}

/** Render a call's callee for display: `fetch` or `fs.writeFile` (`?` for a dynamic receiver). */
function renderCallee(callee: ts.Expression): string {
	if (ts.isIdentifier(callee)) {
		return callee.text;
	}

	if (ts.isPropertyAccessExpression(callee)) {
		return (ts.isIdentifier(callee.expression) ? callee.expression.text : "?") + "." + callee.name.text;
	}

	return "?";
}

/** An inert Response stand-in so a run performs no real network but keeps executing. */
function inertResponse(): unknown {
	return { "ok": true, "status": 200, "json": async () => ({}), "text": async () => "", "arrayBuffer": async () => new ArrayBuffer(0) };
}

/** The tagged host globals + module stand-ins: resolvable AND inert during observation. */
function capabilityStandins(): { "globals": Record<string, unknown>; "modules": Record<string, unknown> } {
	const noop = (): void => { /* inert */ };
	const fsMock = {
		"readFile": tag("fs:read", async () => ""), "readFileSync": tag("fs:read", () => ""),
		"writeFile": tag("fs:write", async () => undefined), "writeFileSync": tag("fs:write", noop),
		"appendFile": tag("fs:write", async () => undefined), "appendFileSync": tag("fs:write", noop),
		"unlink": tag("fs:write", async () => undefined), "unlinkSync": tag("fs:write", noop),
		"mkdir": tag("fs:write", async () => undefined), "mkdirSync": tag("fs:write", noop)
	};
	const childProcessMock = {
		"spawn": tag("exec", () => ({ "on": noop, "stdout": { "on": noop }, "stderr": { "on": noop }, "kill": noop })),
		"spawnSync": tag("exec", () => ({ "status": 0, "stdout": "", "stderr": "" })),
		"exec": tag("exec", (_command: string, callback?: (error: unknown, stdout: string, stderr: string) => void) => { callback?.(null, "", ""); return { "on": noop }; }),
		"execSync": tag("exec", () => ""),
		"execFile": tag("exec", (_file: string, _args: unknown, callback?: (error: unknown, stdout: string, stderr: string) => void) => { callback?.(null, "", ""); return { "on": noop }; })
	};

	return {
		"globals": { "fetch": tag("net", async () => inertResponse()) },
		"modules": {
			"node:fs": fsMock, "fs": fsMock,
			"node:fs/promises": fsMock, "fs/promises": fsMock,
			"node:child_process": childProcessMock, "child_process": childProcessMock
		}
	};
}

/**
 * Run `src` in the tsval interpreter and return the concrete pre-call resource observed at each capability call
 * that executed. Best-effort: a run that throws still returns whatever was observed before the throw.
 */
export async function runCanary(src: string, fileName: string): Promise<CanaryObservation[]> {
	const observations: CanaryObservation[] = [];
	const standins = capabilityStandins();
	let sourceFile: ts.SourceFile | undefined;

	const record = (callee: Tagged, site: HostCallSite): void => {
		const capability = callee[CAPABILITY];

		if (capability === undefined || !ts.isCallExpression(site.node) || sourceFile === undefined) {
			return;
		}

		const argIndex = callee[RESOURCE_ARG] ?? 0;
		const resource = site.args[argIndex];
		const observed = typeof resource === "string";
		const argNode = site.node.arguments[argIndex];
		const staticLiteral = argNode !== undefined && ts.isStringLiteralLike(argNode) ? argNode.text : undefined;

		observations.push({
			"capability": capability,
			"callee": renderCallee(site.node.expression),
			"value": observed ? resource : "",
			"observed": observed,
			"static": staticLiteral,
			"start": site.node.getStart(sourceFile),
			"end": site.node.getEnd(),
			"dangerous": isDangerous(capability)
		});
	};

	const loaded = createVM(src, {
		"fileName": fileName,
		"globals": standins.globals,
		"resolveModule": (specifier) => standins.modules[specifier],
		"hostGuard": {
			"beforeCall": (callee, _thisArg, _isConstruct, site) => {
				record(callee as Tagged, site);

				return callee;
			}
		}
	});

	sourceFile = loaded.sourceFile;

	try {
		await loaded.vm.runAsync();
	} catch (error) { /* best-effort: keep whatever was observed before the throw */ }

	return observations;
}
