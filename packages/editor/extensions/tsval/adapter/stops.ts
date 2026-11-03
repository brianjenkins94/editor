/**
 * A capability stop, on the adapter's side (the run contract's `ask` and `decide`): what the stop tells the editor — the
 * gated call on its line, in the file it's in — and what the editor's answer sends the worker. The bridge's
 * capability-stops.ts asks the person; the worker's stops.ts makes the answer.
 */
import type { AskEvent, DecideRequest } from "@brianjenkins94/editor-api";
import type { CapabilityAsk, Control } from "../debug-protocol";

/** What a stop at `ask` tells the editor: its call, in its own file (and that file's text, when it isn't the entry). */
export function askEvent(ask: CapabilityAsk, program: string, programSource: string): AskEvent {
	const { file, source, ...asked } = ask;
	const text = file === undefined ? programSource : source;

	return { ...asked, "file": file ?? program, ...text === undefined ? {} : { "source": text } };
}

/** The worker's `decide` for the editor's answer at a stop: how the call goes, and the policy from now on when the
 *  answer changed it. */
export function decideControl(answer: DecideRequest): Extract<Control, { "type": "decide" }> {
	const { verdict, value, policy, decided } = answer;

	return { "type": "decide", ...policy === undefined ? {} : { "policy": policy }, "deny": verdict === "deny", "skip": verdict === "skip", ...verdict === "give" ? { "give": value ?? null } : {}, ...decided === undefined ? {} : { "decided": decided } };
}
