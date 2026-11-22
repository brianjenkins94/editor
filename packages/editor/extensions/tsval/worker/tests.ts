import type { CoverageEvent, Effect, TestReport } from "@brianjenkins94/editor-api";
import type ts from "typescript";
import type { Vm } from "./state";
import { siteObservations } from "../site-sums";
import { held, readsStdin } from "./process";
import { EDITOR_SOURCES } from "./runtime";
import { post, state } from "./state";

export const testStarts = new Map<string, Map<ts.SourceFile, number[]>>();

const testClock = new Map<string, number>();
const testStatements = new Map<string, number>();

const testEffects = new Map<string, Map<string, Effect>>();

export function testsEffects(): Map<string, Effect>[] {
	return [...testEffects.values()];
}

export function testTold(kind: string, titles?: string, outcome?: string, error?: string, assertion?: string): void {
	if (kind === "start" && titles !== undefined) {
		testStarts.set(titles, new Map([
			...state.current?.coverage ?? []
		].map(([file, entry]) => [
			file,
			[...entry.counts]
		])));
		testClock.set(titles, performance.now());
		testEffects.set(titles, new Map());

		if (state.current !== undefined) {
			testStatements.set(titles, state.current.statements);
		}
	} else if (kind === "end" && titles !== undefined) {
		const started = testStarts.get(titles);
		const clocked = testClock.get(titles);
		const counted = testStatements.get(titles);
		const effects = [...testEffects.get(titles)?.values() ?? []];
		const statements = counted === undefined || state.current === undefined ? undefined : state.current.statements - counted;

		testStarts.delete(titles);
		testClock.delete(titles);
		testStatements.delete(titles);
		testEffects.delete(titles);
		state.testsRan.push({
			"titles": JSON.parse(titles) as string[],
			"outcome": outcome as TestReport["outcome"],
			...error === undefined
				? {}
				: { "error": error },
			...assertion === undefined
				? {}
				: {
						"assertion": JSON.parse(assertion) as TestReport["assertion"]
					},
			...clocked === undefined
				? {}
				: {
						"ms": Math.round(performance.now() - clocked)
					},
			...statements === undefined || statements < 0
				? {}
				: {
						"statements": statements
					},
			...effects.length === 0
				? {}
				: { "effects": effects },
			"files": [
				...started === undefined
					? []
					: ranSince(started),
				...state.windowReach.splice(0)
			]
		});
	} else if (kind === "done") {
		state.testsFailed = Number(titles ?? 0);
		state.testsDone = true;
	}
}

function ranSince(started: Map<ts.SourceFile, number[]>): TestReport["files"] {
	return [
		...state.current?.coverage ?? []
	].filter(([file]) => !EDITOR_SOURCES.has(file.fileName)).flatMap(([file, entry]) => {
		const before = started.get(file) ?? [];
		const at = (offset: number): [number, number] => {
			const { line, character } = file.getLineAndCharacterOfPosition(offset);

			return [line, character];
		};

		const statements = entry.statements.flatMap((node, index): [[number, number], [number, number]][] => (entry.counts[index] > (before[index] ?? 0)
			? [
					[
						at(node.getStart(file)),
						at(node.getEnd())
					]
				]
			: []));

		return statements.length === 0
			? []
			: [
					{ "file": file.fileName, "statements": statements }
				];
	});
}

export function tellCoverage(): void {
	const reports = [
		...state.current?.coverage ?? []
	].filter(([file]) => !EDITOR_SOURCES.has(file.fileName) && !file.fileName.includes("/node_modules/")).map(([file, entry]): CoverageEvent => {
		const at = (offset: number): [number, number] => {
			const { line, character } = file.getLineAndCharacterOfPosition(offset);

			return [line, character];
		};

		return {
			"file": file.fileName,
			"source": file.text,
			"sites": siteObservations(state.current === undefined
				? undefined
				: state.sumsOf.get(state.current), file),
			"statements": entry.statements.map((node, index) => {
				const { name, expression } = node as ts.Node & { "name"?: ts.Node; "expression"?: ts.Node };
				const head = "body" in node || "thenStatement" in node || "statement" in node
					? name ?? expression
					: undefined;

				return {
					"start": at(node.getStart(file)),
					"end": at(node.getEnd()),
					"count": entry.counts[index] ?? 0,
					...head === undefined
						? {}
						: {
								"anchor": [
									head.getStart(file),
									head.getEnd()
								] as [number, number]
							}
				};
			})
		};
	});
	const [first, ...others] = reports;

	if (first !== undefined) {
		post({
			"type": "coverage",
			"coverage": { ...first, "files": others }
		});
	}
}

export function startTests(): void {
	state.testsRan = [];
	testStarts.clear();
	testEffects.clear();
	state.testsFailed = 0;
	state.testsDone = false;
}

export function testsOver(vm: Vm): boolean {
	return state.testsDone && held.size === 0 && !readsStdin() && ![
		...vm.loop?.timers.values() ?? []
	].some((timer) => timer.ref);
}

export function tellTests(exitCode: number): number {
	if (state.testsRan.length > 0) {
		post({ "type": "tests", "tests": state.testsRan });
	}

	return exitCode === 0 && state.testsFailed > 0
		? 1
		: exitCode;
}
