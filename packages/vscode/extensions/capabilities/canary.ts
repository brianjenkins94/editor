/**
 * Capabilities canary — the DYNAMIC half of the capability IDE (the middle column: concrete pre-call values).
 *
 * The static engine (engine.ts, util/silo `findReach`) captures a capability call's resource only when it's a
 * STATIC STRING LITERAL. The canary covers the rest: it RUNS the module in the tsval interpreter and, at the
 * host↔guest boundary, observes the CONCRETE argument each capability call is actually invoked with — the real
 * URL a `fetch(base + id)` builds, the path a computed `writeFile(dir + name)` writes.
 *
 * The interpreter IS the sandbox: tsval runs with zero ambient authority (no real fetch/fs/exec unless injected),
 * and `HostGuard.beforeCall` fires BEFORE any host call, so nothing dangerous can execute — we observe and hand
 * back an inert stand-in. That's why the canary needs no almostnode-style runtime: almostnode performs REAL
 * effects (real network), the opposite of what a canary wants. `beforeCall` gives the call-expression node (→
 * source span, the same anchor the static rows use) and the arguments AS EVALUATED. Capability calls are
 * classified by the IDENTITY of the injected stand-in (each is tagged), which also catches aliasing
 * (`const f = fetch; f(url)`); danger grading stays with silo policy (`isDangerous`, parser-free).
 *
 * This runs INSIDE the tsserver plugin, reusing tsserver's own `typescript` (the build externalizes it), so the
 * engine ships ~1MB instead of bundling a ~7MB copy. A step budget bounds the run so untrusted code can't hang
 * the language server. M0 scope: CALL capabilities that execute during a normal run (top-level, or reachable from
 * one); `env` is a member read the static half already resolves, so the canary skips it.
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
	 *  source, else undefined (a concatenation / variable / computed value the static half can't resolve). */
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

/**
 * A recursive inert stand-in for an UNMOCKED module, so `import x from "some-lib"` (or `require`) doesn't abort the
 * run — the code keeps going and can still reach the capability calls it makes directly. Callable, constructable,
 * every property yields another inert; it deliberately does NOT look like a Promise (`then` undefined) and iterates
 * as empty, so `await`/destructuring/`for…of` don't hang or throw. Untagged: unmocked modules aren't classified
 * (a future refinement can tag known HTTP clients like axios); this is purely about not stopping the run.
 */
function inert(): unknown {
	const target = function() { /* inert */ };

	return new Proxy(target, {
		"get": (_target, property) => {
			if (property === "then") {
				return undefined; // not a thenable — don't let `await` adopt it
			}

			if (property === Symbol.iterator) {
				return function *() { /* empty */ };
			}

			if (property === Symbol.toPrimitive || property === "toString" || property === "valueOf") {
				return () => "";
			}

			return inert();
		},
		"apply": () => inert(),
		"construct": () => inert()
	});
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
 * that executed. Best-effort: a run that throws (or exceeds the step budget) still returns whatever was observed
 * before it stopped.
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
		// A fuel limit: this runs untrusted module code INSIDE the tsserver worker, so a `while (true)` must not
		// hang the language server. Exceeding it throws uncatchably → caught below, partial observations kept.
		"maxSteps": 5_000_000,
		"globals": standins.globals,
		// Known capability modules → tagged inert mocks; anything else → a recursive inert stand-in so the import
		// doesn't abort the run (coverage) while still doing nothing real.
		"resolveModule": (specifier) => (Object.prototype.hasOwnProperty.call(standins.modules, specifier) ? standins.modules[specifier] : inert()),
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
	} catch (error) { /* best-effort: keep whatever was observed before the throw / budget stop */ }

	return observations;
}
