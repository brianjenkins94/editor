import type { CpuProfile } from "@brianjenkins94/editor-api/cpuprofile";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { Bablr } from "./bablr";
import type { EvidenceIntake, FunctionTime } from "./evidence";
import type { RunRegistry } from "./runs";
import { parseVirtual } from "../shared/virtual-path";
import { inlineSourceMap, originalPosition } from "./sourcemap";

interface Profiled { "window": string; "port": number; "page": string; "profile": CpuProfile }

interface Sampled { "line": number; "column": number; "selfMs": number; "totalMs": number; "callers": Record<string, number>; "callees": Record<string, number> }

async function sourceMapped(vscode: typeof vscodeApi, profile: CpuProfile, port: number, page: string, root: string): Promise<CpuProfile> {
	const maps = new Map<string, Promise<ReturnType<typeof inlineSourceMap>>>();
	const mapOf = (url: string): Promise<ReturnType<typeof inlineSourceMap>> => {
		let map = maps.get(url);

		if (map === undefined) {
			map = fetch(url).then(async (response) => (response.ok ? inlineSourceMap(await response.text()) : undefined), () => undefined);
			maps.set(url, map);
		}

		return map;
	};

	const base = root.replace(/\/$/u, "");
	const prefix = parseVirtual(page)?.prefix;
	const files = new Map<string, Promise<boolean>>();
	const inRoot = (path: string): Promise<boolean> => {
		let found = files.get(path);

		if (found === undefined) {
			found = Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(base + path))).then(() => true, () => false);
			files.set(path, found);
		}

		return found;
	};
	const served = async (url: string): Promise<{ "path": string; "url": string } | undefined> => {
		if (!URL.canParse(url) || new URL(url).origin !== location.origin) {
			return undefined;
		}

		const { pathname } = new URL(url);
		const address = parseVirtual(pathname);

		if (address !== undefined) {
			return address.port === port ? { "path": decodeURIComponent(address.rest), "url": url } : undefined;
		}

		return prefix !== undefined && await inRoot(decodeURIComponent(pathname)) ? { "path": decodeURIComponent(pathname), "url": location.origin + prefix + pathname } : undefined;
	};

	const nodes = await Promise.all(profile.nodes.map(async (node) => {
		const module = await served(node.callFrame.url);
		const path = module?.path;

		if (module === undefined || path === undefined || path === "" || path === "/" || path.startsWith("/@") || path.includes("/node_modules/")) {
			return node;
		}

		const map = await mapOf(module.url);
		const original = map === undefined || node.callFrame.lineNumber < 0 ? undefined : originalPosition(map, node.callFrame.lineNumber, Math.max(0, node.callFrame.columnNumber));
		const file = original === undefined ? base + path : base + path.slice(0, path.lastIndexOf("/") + 1) + original.source.replace(/^.*\//u, "");

		return {
			...node,
			"callFrame": {
				...node.callFrame,
				"url": `file://${file}`,
				"lineNumber": original?.line ?? node.callFrame.lineNumber,
				"columnNumber": original?.column ?? node.callFrame.columnNumber
			}
		};
	}));

	return { ...profile, "nodes": nodes };
}

function sampled(profile: CpuProfile): Map<string, Map<string, Sampled>> {
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const parentOf = new Map<number, number>();
	const files = new Map<string, Map<string, Sampled>>();

	for (const node of profile.nodes) {
		for (const child of node.children) {
			parentOf.set(child, node.id);
		}
	}

	const nameOf = (id: number | undefined): string | undefined => {
		const name = id === undefined ? undefined : byId.get(id)?.callFrame.functionName;

		return name === undefined || name === "(root)" ? undefined : name || "(anonymous)";
	};
	const shownName = (id: number | undefined): string | undefined => {
		const url = id === undefined ? undefined : byId.get(id)?.callFrame.url;

		return url === "" || url?.startsWith("file://") === true ? nameOf(id) : undefined;
	};

	profile.samples.forEach((leaf, index) => {
		const ms = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
		const stack: number[] = [];

		for (let at: number | undefined = leaf; at !== undefined && nameOf(at) !== undefined; at = parentOf.get(at)) {
			stack.push(at);
		}

		const seen = new Set<string>();

		stack.forEach((id, depth) => {
			const { url, lineNumber, columnNumber } = byId.get(id)!.callFrame;

			if (!url.startsWith("file://")) {
				return;
			}

			const file = url.slice("file://".length);
			const key = `${String(lineNumber)}:${String(columnNumber)}`;
			const functions = files.get(file) ?? new Map<string, Sampled>();
			const known = functions.get(key) ?? { "line": lineNumber, "column": columnNumber, "selfMs": 0, "totalMs": 0, "callers": {}, "callees": {} };
			const caller = shownName(stack[depth + 1]);
			const callee = depth === 0 ? undefined : shownName(stack[depth - 1]);

			files.set(file, functions);
			functions.set(key, known);
			known.selfMs += depth === 0 ? ms : 0;

			if (!seen.has(key)) {
				seen.add(key);
				known.totalMs += ms;

				if (caller !== undefined) {
					known.callers[caller] = (known.callers[caller] ?? 0) + ms;
				}

				if (callee !== undefined) {
					known.callees[callee] = (known.callees[callee] ?? 0) + ms;
				}
			}
		});
	});

	return files;
}

function offsetOf(source: string, line: number, column: number): number {
	let at = 0;

	for (let each = 0; each < line; each += 1) {
		const next = source.indexOf("\n", at);

		if (next === -1) {
			return source.length;
		}

		at = next + 1;
	}

	return at + column;
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassMethod", "Method"]);

async function functionTimes(bablr: Bablr, source: string, functions: Sampled[]): Promise<FunctionTime[]> {
	const { spans = [] } = await bablr.spans(source);
	const candidates = spans.filter((each) => each.type !== undefined && FUNCTIONS.has(each.type));
	const bySpan = new Map<string, FunctionTime>();

	for (const each of functions) {
		const offset = offsetOf(source, each.line, Math.max(0, each.column));
		const [around] = candidates.filter(({ start, end }) => start <= offset && offset < end).sort((a, b) => (a.end - a.start) - (b.end - b.start));

		if (around !== undefined) {
			const known = bySpan.get(around.id);

			bySpan.set(around.id, known === undefined
				? { "span": around.id, "selfMs": each.selfMs, "totalMs": each.totalMs, "callers": each.callers, "callees": each.callees }
				: { ...known, "selfMs": known.selfMs + each.selfMs, "totalMs": known.totalMs + each.totalMs, "callers": { ...known.callers, ...each.callers }, "callees": { ...known.callees, ...each.callees } });
		}
	}

	return [...bySpan.values()];
}

export function installProfileTimes(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry, bablr: Bablr, evidence: EvidenceIntake, log: Logger): void {
	hub.subscribe("preview.profiled", (data) => {
		const { port, "window": key, page, profile } = (data ?? {}) as Partial<Profiled>;
		const run = typeof port === "number" ? runs.runningService((candidate) => candidate.port === port) : undefined;

		if (run === undefined || port === undefined || profile === undefined) {
			return;
		}

		void log.span("editor.workbench.profile-times.keep", { "window": key ?? "", "count": profile.nodes.length }, async (span) => {
			const files = sampled(await sourceMapped(vscode, profile, port, page ?? "", run.cwd));
			const profiledMs = (profile.endTime - profile.startTime) / 1000;
			let kept = 0;

			for (const [file, functions] of files) {
				const source = await Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
				const times = source === undefined ? [] : await functionTimes(bablr, source, [...functions.values()]);

				if (source !== undefined && times.length > 0) {
					evidence.times(run.id, file, { "source": source, "profiledMs": profiledMs, "functions": times });
					kept += times.length;
				}
			}

			span.end({ "files": files.size, "functions": kept });
		}).catch((error: unknown) => {
			log.warn("a preview's profile couldn't be kept with its run", { "window": key ?? "", "error": String(error) });
		});
	});
}
