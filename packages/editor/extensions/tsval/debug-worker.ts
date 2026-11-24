import type { ToWorker } from "./debug-protocol";
import { connectRuntime } from "@brianjenkins94/editor-api/runtime";
import { exploreOrderings } from "./worker/explore";
import { typed } from "./worker/process";
import { launch, setBreakpoints, setPace, setValue } from "./worker/session";
import { countLinkCalls, post, state } from "./worker/state";
import { decide } from "./worker/stops";

globalThis.addEventListener("message", (event: MessageEvent<ToWorker>): void => {
	if (event.data.kind === "runtime") {
		state.editorLink = countLinkCalls(connectRuntime(event.data.port, { "name": "debug-worker" }));

		return;
	}

	if (event.data.kind === "publish") {
		(globalThis as { "__evidence"?: { "publish"?: () => void } }).__evidence?.publish?.();

		return;
	}

	const message = event.data.control;
	const { trace } = event.data;

	switch (message.type) {
		case "launch": {
			launch(message, trace);
			break;
		}

		case "explore":
			void exploreOrderings(message).then((explored) => {
				post({ "type": "explored", "explored": explored });
			});
			break;

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
				state.actionTrace = trace;
				const resolve = state.awaitAction;

				state.awaitAction = undefined;
				resolve(message.type);
			}

			break;

		default:
			break;
	}
});
