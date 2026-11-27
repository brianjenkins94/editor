import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";

const TEST_FILE = /(?:^|\/)tests?\/|(?:^|[./_-])(?:test|spec)[._-]/u;

const TOP = "(top)";

export type UnrunKind = "nothing" | "exported" | "called" | "used";

export interface Unrun { "file": string; "name": string; "line": number; "text": string; "callers": number; "kind": UnrunKind }

export interface UnrunInputs {
	"graph": Pick<DeclarationGraph, "nodes" | "edges">;
	"analyses": ReadonlyMap<string, Pick<FileAnalysis, "declarations">>;
	"texts": ReadonlyMap<string, string>;
	"tested": Readonly<Record<string, ReadonlySet<number>>>;
	"used": Readonly<Record<string, readonly [number, number][]>>;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length - 1;

const isTypeOnly = (head: string): boolean => /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s/u.test(head);

const isCallable = (head: string): boolean => /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b|=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[\w$]+\s*=>)/u.test(head);

export function callersOf(graph: UnrunInputs["graph"], declared: ReadonlySet<string>): Map<string, Set<string>> {
	const users = new Map<string, Set<string>>();
	const add = (target: string, user: string): void => {
		if (target !== user) {
			users.set(target, (users.get(target) ?? new Set()).add(user));
		}
	};

	for (const node of graph.nodes()) {
		if (!declared.has(node)) {
			continue;
		}

		for (const target of graph.edges(node)) {
			if (declared.has(target)) {
				add(target, node);
			} else {
				for (const through of graph.edges(target)) {
					if (declared.has(through)) {
						add(through, node);
					}
				}
			}
		}
	}

	return users;
}

interface Imported { "name": string; "relative"?: string; "pkg"?: string; "sub"?: string }

const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu;

const withoutExtension = (file: string): string => file.replace(/\.[cm]?[jt]sx?$/u, "");

function normalized(path: string): string {
	const parts: string[] = [];

	for (const part of path.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "." && part !== "") {
			parts.push(part);
		}
	}

	return parts.join("/");
}

export function importsIn(texts: ReadonlyMap<string, string>): Imported[] {
	const found: Imported[] = [];

	for (const [file, text] of texts) {
		if (TEST_FILE.test(file) || !/\.[cm]?[jt]sx?$/u.test(file)) {
			continue;
		}

		for (const [, names, spec] of text.matchAll(IMPORT)) {
			const where = spec.startsWith(".")
				? { "relative": withoutExtension(normalized(`${file.slice(0, file.lastIndexOf("/"))}/${spec}`)) }
				: (() => {
						const bare = spec.replace(/^@[^/]+\//u, "");
						const slash = bare.indexOf("/");

						return slash === -1 ? { "pkg": bare, "sub": "index" } : { "pkg": bare.slice(0, slash), "sub": bare.slice(slash + 1) };
					})();

			for (const each of names.split(",")) {
				const name = each.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0];

				if (name !== "") {
					found.push({ "name": name, ...where });
				}
			}
		}
	}

	return found;
}

export function isImported(file: string, name: string, imports: readonly Imported[]): boolean {
	const bare = withoutExtension(file);

	return imports.some((each) => each.name === name && (each.relative === undefined
		? bare.includes(`/${each.pkg ?? ""}/`) && bare.endsWith(`/${each.sub ?? ""}`)
		: each.relative === bare));
}

function kindOf(ranInUse: boolean, calledBy: number, exported: boolean): UnrunKind {
	if (ranInUse) {
		return "used";
	}

	if (calledBy > 0) {
		return "called";
	}

	return exported ? "exported" : "nothing";
}

export function unrunOf({ graph, analyses, texts, tested, used }: UnrunInputs): Unrun[] {
	const declared = new Set([...analyses].flatMap(([file, analysis]) => Object.keys(analysis.declarations).map((name) => `${file}#${name}`)));
	const callers = callersOf(graph, declared);
	const imports = importsIn(texts);
	const found: Unrun[] = [];

	for (const [file, analysis] of analyses) {
		const text = texts.get(file);

		if (text === undefined || TEST_FILE.test(file) || file.includes("node_modules/")) {
			continue;
		}

		for (const [name, { range }] of Object.entries(analysis.declarations)) {
			if (name === TOP || range === undefined) {
				continue;
			}

			const head = text.slice(range[0], text.indexOf("\n", range[0]) === -1 ? range[1] : Math.min(range[1], text.indexOf("\n", range[0])));

			if (isTypeOnly(head)) {
				continue;
			}

			const [first, last] = [lineOf(text, range[0]), lineOf(text, range[1])];
			const inBody = isCallable(head) && last > first;
			const from = inBody ? first + 1 : first;
			const ranInTests = [...tested[file] ?? []].some((line) => line >= from && line <= last);

			if (ranInTests) {
				continue;
			}

			const bodyStart = inBody ? text.indexOf("\n", range[0]) : range[0];
			const ranInUse = (used[file] ?? []).some(([start, end]) => start >= bodyStart && end <= range[1]);
			const graphed = callers.get(`${file}#${name}`)?.size ?? 0;
			const calledBy = graphed === 0 && isImported(file, name, imports) ? 1 : graphed;

			found.push({
				"file": file,
				"name": name,
				"line": first + 1,
				"text": head.trim().slice(0, 160),
				"callers": calledBy,
				"kind": kindOf(ranInUse, calledBy, /^export\b/u.test(head))
			});
		}
	}

	return found.sort((one, other) => one.file.localeCompare(other.file) || one.line - other.line);
}
