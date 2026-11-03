/**
 * A test file's tests as node-test.js tells them (`__editorTest`): each one's outcome, what it threw, a failed
 * assertion's sides, its time, and the statements it ran.
 */
import type { TestReport } from "@brianjenkins94/editor-api";
import type { Vm } from "./state";
import ts from "typescript";
import { held, readsStdin } from "./process";
import { EDITOR_SOURCES } from "./runtime";
import { post, state } from "./state";

/** Each running test's coverage counts as it started, by its titles (JSON): what ran since is that test's. */
export const testStarts = new Map<string, Map<ts.SourceFile, number[]>>();

/** When each test started, by the host's clock (the program's runs on the deterministic loop's): its time. */
const testClock = new Map<string, number>();

/** node-test.js's `__editorTest`: a test started (`titles`), ended (and how: `outcome`, what it threw, and what a failed
 *  assertion compared, as JSON), or the file's tests are done (`titles` then the count that failed). Called from the
 *  program's code, with strings only. */
export function testTold(kind: string, titles?: string, outcome?: string, error?: string, assertion?: string): void {
	if (kind === "start" && titles !== undefined) {
		testStarts.set(titles, new Map([...state.current?.coverage ?? []].map(([file, entry]) => [file, [...entry.counts]])));
		testClock.set(titles, performance.now());
	} else if (kind === "end" && titles !== undefined) {
		const started = testStarts.get(titles);
		const clocked = testClock.get(titles);

		testStarts.delete(titles);
		testClock.delete(titles);
		state.testsRan.push({
			"titles": JSON.parse(titles) as string[],
			"outcome": outcome as TestReport["outcome"],
			...error === undefined ? {} : { "error": error },
			...assertion === undefined ? {} : { "assertion": JSON.parse(assertion) as TestReport["assertion"] },
			...clocked === undefined ? {} : { "ms": Math.round(performance.now() - clocked) },
			"files": started === undefined ? [] : ranSince(started)
		});
	} else if (kind === "done") {
		state.testsFailed = Number(titles ?? 0);
		state.testsDone = true;
	}
}

/** The statements that ran since `started` (each file's counts then), in each of the program's files. */
function ranSince(started: Map<ts.SourceFile, number[]>): TestReport["files"] {
	return [...state.current?.coverage ?? []].filter(([file]) => !EDITOR_SOURCES.has(file.fileName)).flatMap(([file, entry]) => {
		const before = started.get(file) ?? [];
		const at = (offset: number): [number, number] => {
			const { line, character } = file.getLineAndCharacterOfPosition(offset);

			return [line, character];
		};
		const statements = entry.statements.flatMap((node, index): [[number, number], [number, number]][] => (entry.counts[index] > (before[index] ?? 0) ? [[at(node.getStart(file)), at(node.getEnd())]] : []));

		return statements.length === 0 ? [] : [{ "file": file.fileName, "statements": statements }];
	});
}

/** A run's tests, none yet: its launch. */
export function startTests(): void {
	state.testsRan = [];
	testStarts.clear();
	state.testsFailed = 0;
	state.testsDone = false;
}

/** A test file's tests all done, and nothing left that Node counts as keeping a process alive — no ref'd timer, server or
 *  stdin — only promises that nothing here will settle (a package's): it ends, as `node --test` does. (Before then a
 *  pending promise may be a request in flight, which the browser shows no handle for.) */
export function testsOver(vm: Vm): boolean {
	return state.testsDone && held.size === 0 && !readsStdin() && ![...vm.loop?.timers.values() ?? []].some((timer) => timer.ref);
}

/** The run's end: a test file's tests told, each with what it ran; `exitCode`, or 1 when one failed, as `node --test`. */
export function tellTests(exitCode: number): number {
	if (state.testsRan.length > 0) {
		post({ "type": "tests", "tests": state.testsRan });
	}

	return exitCode === 0 && state.testsFailed > 0 ? 1 : exitCode;
}
