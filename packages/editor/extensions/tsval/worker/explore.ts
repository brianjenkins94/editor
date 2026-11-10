/**
 * Every ordering of the program's events (tsval's explore, packages/tsval/src/explore.ts): each run fresh, with the
 * stand-ins a run of a given schedule has, so every host call answers at once, and which answer comes first, or whether
 * one comes before a timer, is the choice. No breakpoints, no stops. Each distinct ending: what it printed and where (a
 * crash too: a throw, or a rejection nothing handled), a schedule that gets there, and the events chosen along it.
 */
import type { Control, Explored, Ordering, Printed } from "../debug-protocol";
import type { Vm } from "./state";
import { asyncContext } from "@brianjenkins94/almostnode/async-context";
import { createVM, explore, runToEnd } from "@brianjenkins94/tsval";
import { capabilitySurface, functionsIn } from "./gate";
import { programModules, runtimeReady } from "./runtime";
import { formatLogArg } from "./session";
import { state, workerLog } from "./state";

/** Where `error` was thrown, if tsval noted it: the file and 1-based line. */
function thrownAt(vm: Vm | undefined, error: unknown): { "file"?: string; "line"?: number } {
	try {
		const at = vm?.location(vm.throwSite(error));

		return at === null || at === undefined
			? {}
			: { "file": at.file, "line": at.line + 1 };
	} catch {
		return {};
	}
}

export async function exploreOrderings(message: Extract<Control, { "type": "explore" }>): Promise<Explored> {
	return workerLog().span("editor.extensions.tsval.worker.explore.orderings", { "path": message.fileName }, async (span) => {
		state.policy = message.policy;
		state.live = false;
		state.recordedResults = {};
		state.runLayer = undefined;

		const loaded = await runtimeReady(message.workspace);

		const found = await explore(async (schedule) => {
			const output: Printed[] = [];
			// (no runtime given: each call its stand-in, as a launch of one ordering has, so the run it debugs goes this way)
			const surface = capabilitySurface(message.fileName, message.args ?? []);
			let vm: Vm | undefined;

			// Each run from scratch: its own modules (the program's evaluated again), its own stand-ins.
			state.runtime?.clearCache();
			state.programBuiltins = surface.modules;
			state.programFunctions = functionsIn([surface.modules, surface.globals]);

			const write = (...args: unknown[]): void => {
				const at = vm?.location();

				output.push({
					"text": args.map(formatLogArg).join(" "),
					"file": at?.file ?? message.fileName,
					"line": (at?.line ?? 0) + 1
				});
			};

			const console = Object.fromEntries([
				"log",
				"info",
				"debug",
				"dir",
				"warn",
				"error",
				"trace"
			].map((name) => [name, write]));

			({ vm } = createVM(message.source, {
				"fileName": message.fileName,
				"globals": {
					...state.nodeGlobals,
					...surface.globals,
					"console": console
				},
				"modules": programModules(loaded),
				"eventLoop": { ...message.eventLoop, "schedule": schedule, "pace": "fast" },
				"asyncContext": asyncContext,
				"sharedGlobals": state.runGlobal?.own
			}));
			state.evaluating = vm;

			let crash: Ordering["crash"];
			const unhandled = (event: PromiseRejectionEvent): void => {
				crash ??= {
					"message": event.reason instanceof Error
						? event.reason.message
						: String(event.reason),
					...thrownAt(vm, event.reason)
				};
				event.preventDefault();
			};

			globalThis.addEventListener("unhandledrejection", unhandled);

			try {
				await runToEnd(vm);
			} catch (error) {
				crash = {
					"message": error instanceof Error
						? error.message
						: String(error),
					...thrownAt(vm, error)
				};
			} finally {
				// A rejection nothing handled is told a turn later.
				await new Promise((resolve) => {
					setTimeout(resolve, 0);
				});
				globalThis.removeEventListener("unhandledrejection", unhandled);
			}

			return {
				"outcome": {
					"output": output,
					...crash === undefined
						? {}
						: { "crash": crash }
				},
				"choices": vm.choices
			};
		}, { "maxRuns": message.maxRuns ?? 100 });

		span.end({ "runs": found.runs, "count": found.outcomes.length, "complete": found.complete });

		return {
			"runs": found.runs,
			"complete": found.complete,
			"eventLoop": message.eventLoop,
			"outcomes": found.outcomes.map(({ outcome, schedule, choices, runs }) => ({
				...outcome,
				"schedule": schedule,
				"path": choices.map((choice) => choice.candidates[choice.picked].label),
				"runs": runs
			}))
		};
	});
}
