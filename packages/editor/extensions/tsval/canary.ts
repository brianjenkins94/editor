import type { HostCallSite } from "@brianjenkins94/tsval";
import type { CapabilityHit } from "./capability-calls";
import { FS_ASYNC, FS_DESTINATION, FS_SYNC } from "@brianjenkins94/almostnode/fs-capabilities";
import { createVM } from "@brianjenkins94/tsval";
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import ts from "typescript";
import { classifyCall, renderCallee } from "./capability-calls";

export interface CanaryObservation {
	"capability": string;
	"callee": string;
	"value": string;
	"observed": boolean;
	"static"?: string;
	"start": number;
	"end": number;
	"dangerous": boolean;
}

const CAPABILITY = Symbol("capabilities.canary.capability");
const RESOURCE_ARG = Symbol("capabilities.canary.resourceArg");
const LANDING = Symbol("capabilities.canary.landing");

type Tagged = ((...args: unknown[]) => unknown) & { [CAPABILITY]?: string; [RESOURCE_ARG]?: number; [LANDING]?: string };

function tag<T extends (...args: never[]) => unknown>(capability: string, fn: T, resourceArg = 0, landing?: string): T {
	(fn as Tagged)[CAPABILITY] = capability;
	(fn as Tagged)[RESOURCE_ARG] = resourceArg;

	if (landing !== undefined) {
		(fn as Tagged)[LANDING] = landing;
	}

	return fn;
}

export function standinCapability(fn: unknown): { "capability": string; "resourceArg": number; "landing"?: string } | undefined {
	const capability = typeof fn === "function" ? (fn as Tagged)[CAPABILITY] : undefined;
	const landing = capability === undefined ? undefined : (fn as Tagged)[LANDING];

	return capability === undefined ? undefined : { "capability": capability, "resourceArg": (fn as Tagged)[RESOURCE_ARG] ?? 0, ...landing === undefined ? {} : { "landing": landing } };
}

export function givenAs(capability: string, real: unknown, value: unknown): unknown {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const settle = (shaped: unknown): unknown => (real instanceof Promise ? Promise.resolve(shaped) : shaped);

	if (capability === "net") {
		const json = (): Promise<unknown> => new Promise((resolve) => {
			resolve(typeof value === "string" ? JSON.parse(value) as unknown : value);
		});

		return settle({ "ok": true, "status": 200, "statusText": "OK", "json": json, "text": () => Promise.resolve(text), "arrayBuffer": () => Promise.resolve(new TextEncoder().encode(text).buffer) });
	}

	if (capability === "fs:read") {
		return settle(text);
	}

	if (capability === "exec") {
		return settle(typeof real === "object" && real !== null && "stdout" in real ? { ...real, "stdout": text } : text);
	}

	return real;
}

function tagHit(callee: Tagged, site: HostCallSite): CapabilityHit | undefined {
	const capability = callee[CAPABILITY];

	if (capability === undefined || !ts.isCallExpression(site.node)) {
		return undefined;
	}

	const argIndex = callee[RESOURCE_ARG] ?? 0;
	const resource = site.args[argIndex];

	return { "capability": capability, "resource": typeof resource === "string" ? resource : "", "callee": renderCallee(site.node.expression), "dangerous": isDangerous(capability), "argIndex": argIndex };
}

function inertResponse(): unknown {
	return { "ok": true, "status": 200, "json": () => Promise.resolve({}), "text": () => Promise.resolve(""), "arrayBuffer": () => Promise.resolve(new ArrayBuffer(0)) };
}

export function inert(): unknown {
	function target(): void { /* inert */ }

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

export function capabilityStandins(): { "globals": Record<string, unknown>; "modules": Record<string, unknown> } {
	const noop = (): void => { /* inert */ };
	const fsResults: Record<string, () => unknown> = { "readdir": () => [], "readdirSync": () => [], "existsSync": () => false, "createReadStream": inert, "createWriteStream": inert };
	const resultOf = (method: string, op: string): () => unknown => {
		const result = fsResults[method] ?? (op === "read" && FS_DESTINATION[method] === undefined ? () => "" : noop);

		return () => result();
	};
	const landingOf = (method: string): string | undefined => (FS_DESTINATION[method] === undefined ? undefined : "fs:" + FS_DESTINATION[method]);
	const fsMock = Object.fromEntries([
		...Object.entries(FS_SYNC).map(([method, op]) => [method, tag("fs:" + op, resultOf(method, op), 0, landingOf(method))]),
		...Object.entries(FS_ASYNC).map(([method, op]) => [
			method,
			tag("fs:" + op, () => Promise.resolve(resultOf(method, op)()), 0, landingOf(method))
		])
	]);
	const childProcessMock = {
		"spawn": tag("exec", () => ({ "on": noop, "stdout": { "on": noop }, "stderr": { "on": noop }, "kill": noop })),
		"spawnSync": tag("exec", () => ({ "status": 0, "stdout": "", "stderr": "" })),
		"exec": tag("exec", (_command: string, callback?: (error: unknown, stdout: string, stderr: string) => void) => {
			callback?.(null, "", "");

			return { "on": noop };
		}),
		"execSync": tag("exec", () => ""),
		"execFile": tag("exec", (_file: string, _args: unknown, callback?: (error: unknown, stdout: string, stderr: string) => void) => {
			callback?.(null, "", "");

			return { "on": noop };
		})
	};

	return {
		"globals": { "fetch": tag("net", () => Promise.resolve(inertResponse())) },
		"modules": {
			"node:fs": fsMock,
			"fs": fsMock,
			"node:fs/promises": fsMock,
			"fs/promises": fsMock,
			"node:child_process": childProcessMock,
			"child_process": childProcessMock
		}
	};
}

export async function runCanary(src: string, fileName: string): Promise<CanaryObservation[]> {
	const observations: CanaryObservation[] = [];
	const standins = capabilityStandins();
	let sourceFile: ts.SourceFile | undefined;

	const record = (callee: Tagged, site: HostCallSite): void => {
		if (sourceFile === undefined || !ts.isCallExpression(site.node)) {
			return;
		}

		const classified = classifyCall(site.node, site.args);
		const fallback = tagHit(callee, site);
		const hits = classified.length > 0 ? classified : fallback === undefined ? [] : [fallback];

		for (const hit of hits) {
			const argNode = site.node.arguments[hit.argIndex];
			const resource = site.args[hit.argIndex];
			const observed = typeof resource === "string";
			const staticLiteral = argNode !== undefined && ts.isStringLiteralLike(argNode) ? argNode.text : undefined;

			observations.push({
				"capability": hit.capability,
				"callee": hit.callee,
				"value": observed ? resource : "",
				"observed": observed,
				"static": staticLiteral,
				"start": site.node.getStart(sourceFile),
				"end": site.node.getEnd(),
				"dangerous": hit.dangerous
			});
		}
	};

	const loaded = createVM(src, {
		"fileName": fileName,
		"maxSteps": 5_000_000,
		"globals": standins.globals,
		"resolveModule": (specifier) => (Object.hasOwn(standins.modules, specifier) ? standins.modules[specifier] : inert()),
		"hostGuard": {
			"beforeCall": (callee, _thisArg, _isConstruct, site) => {
				record(callee, site);

				return callee;
			}
		}
	});

	({ sourceFile } = loaded);

	try {
		await loaded.vm.runAsync();
	} catch (error) { /* best-effort: keep whatever was observed before the throw / budget stop */ }

	return observations;
}
