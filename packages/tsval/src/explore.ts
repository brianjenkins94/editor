/**
 * Every way a program can go (event-loop.ts): where its event loop has a choice — which of the host calls' results that
 * are in comes next, or whether one comes before the next timer — each way is a schedule, and `explore` runs them,
 * depth-first, one fresh run per schedule: the distinct outcomes, each with a schedule that reaches it, to run again
 * exactly (EventLoopOptions.schedule) — in a debugger, to step through. A race is outcomes that differ.
 *
 * It explores what the program's own code decides between; how long a real host call takes isn't its to choose, so a
 * run's host calls should answer at once (a debugger's stand-ins do) — a result not in yet is no candidate.
 */
import type { Choice } from "./event-loop.ts";
import type { VM } from "./vm.ts";

/** A run's outcome, and the choices it made. */
export interface Run<T> { "outcome": T; "choices": readonly Choice[] }

/** What exploring found: how many runs it took, whether every schedule was run (not cut short by `maxRuns`), and each
 *  distinct outcome — a schedule that reaches it, the choices along it, and how many runs ended that way. */
export interface Explored<T> {
	"runs": number;
	"complete": boolean;
	"outcomes": { "outcome": T; "schedule": number[]; "choices": readonly Choice[]; "runs": number }[];
}

/** Run `run` for each schedule there is (at most `maxRuns`), from the default one: each choice point a run reaches
 *  beyond the schedule it was given, each other choice there, a schedule to run next. Outcomes are told apart by `key`
 *  (their JSON, by default). */
export async function explore<T>(run: (schedule: number[]) => Promise<Run<T>>, { maxRuns = 200, key = (outcome: T): string => JSON.stringify(outcome) ?? "undefined" }: { "maxRuns"?: number; "key"?: (outcome: T) => string } = {}): Promise<Explored<T>> {
	const todo: number[][] = [[]];
	const outcomes = new Map<string, Explored<T>["outcomes"][number]>();
	let runs = 0;

	while (todo.length > 0 && runs < maxRuns) {
		const schedule = todo.pop()!;
		const { outcome, choices } = await run(schedule);
		const id = key(outcome);
		const picked = choices.map((choice) => choice.picked);

		runs += 1;

		const known = outcomes.get(id);

		if (known === undefined) {
			outcomes.set(id, { "outcome": outcome, "schedule": picked, "choices": choices, "runs": 1 });
		} else {
			known.runs += 1;
		}

		// The choice points past the schedule were taken the default way: each other way, a schedule (nearest first).
		for (let index = choices.length - 1; index >= schedule.length; index -= 1) {
			for (let other = choices[index]!.candidates.length - 1; other >= 0; other -= 1) {
				if (other !== choices[index]!.picked) {
					todo.push([...picked.slice(0, index), other]);
				}
			}
		}
	}

	return { "runs": runs, "complete": todo.length === 0, "outcomes": [...outcomes.values()] };
}

/** Drive `vm` to its end (no breakpoints are stops here: it runs past them), letting what's pending settle and timers
 *  come due as it idles. */
export async function runToEnd(vm: VM): Promise<void> {
	while (!vm.finished) {
		vm.runToBreakpoint();

		while (vm.idle) {
			await vm.whenSettled();
			vm.runToBreakpoint();
		}
	}
}
