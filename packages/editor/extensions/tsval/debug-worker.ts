/**
 * tsval debug worker — runs the target program under tsval's stepping VM and adds TIME TRAVEL. It speaks
 * debug-protocol.ts over the pod hub: control arrives on its session's control subject, stops and output go out on its
 * event subject.
 *
 * Pausing is ASYNC: the whole program is driven by THIS worker's own loop (`runToBreakpoint`/`stepStatement`/`step`),
 * so to "pause" the loop simply awaits the next control message. The exception is a breakpoint inside a guest call the
 * host makes synchronously (a server's handler, a library's callback): that blocks the worker on Atomics.wait until the adapter
 * resumes it through the shared control word (see onBreakpointHook).
 *
 * Time travel is tsval's `fork()` — a full, independent snapshot of the machine (frames are plain data, so
 * the whole state clones). We keep a HISTORY of forks, one per stop: forward actions fork the current stop and
 * advance a copy (leaving the stored fork pristine); backward actions just move the index and re-emit an
 * earlier fork. Because the interpreter is deterministic, re-advancing after a step-back reproduces the same
 * states. Only user (guest) state lives in the fork — native side effects would not rewind, but a plain
 * program has none, which is exactly why time travel is clean here.
 *
 * On every stop the worker sends the adapter a COMPLETE snapshot (frame + Locals scope + variable values), so
 * the adapter answers stackTrace/scopes/variables from it with no round-trip.
 */
import type { ToWorker } from "./debug-protocol";
import { connectRuntime } from "@brianjenkins94/editor-api/runtime";
import { typed } from "./worker/process";
import { launch, setBreakpoints, setPace, setValue } from "./worker/session";
import { post, state } from "./worker/state";
import { decide } from "./worker/stops";

globalThis.addEventListener("message", (event: MessageEvent<ToWorker>): void => {
	if (event.data.kind === "runtime") {
		state.editorLink = connectRuntime(event.data.port, { "name": "debug-worker" });

		return;
	}

	const message = event.data.control;
	const { trace } = event.data;

	switch (message.type) {
		case "launch": {
			launch(message, trace);
			break;
		}

		case "setBreakpoints":
			setBreakpoints(message);
			break;

		case "stdin":
			typed(message);
			break;

		case "pace":
			setPace(message);
			break;

		case "setValue":
			// The stop's own machine (the pristine snapshot a continue forks from), so the run goes on with the value.
			post(state.done || state.history[state.index] === undefined ? { "type": "valueSet", "ok": false, "error": "not stopped" } : setValue(state.history[state.index], message.name, message.value));
			break;

		case "decide":
			decide(message);
			break;

		case "continue":
		case "next":
		case "stepIn":
		case "stepOut":
		case "stepBack":
		case "reverseContinue":
		case "disconnect":
			if (state.awaitAction !== undefined) {
				state.actionTrace = trace; // continue the adapter action's trace in the step it drives
				const resolve = state.awaitAction;

				state.awaitAction = undefined;
				resolve(message.type);
			}

			break;

		default:
			break;
	}
});
