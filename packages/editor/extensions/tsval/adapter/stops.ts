import type { AskEvent, DecideRequest } from "@brianjenkins94/editor-api";
import type { CapabilityAsk, Control } from "../debug-protocol";

export function askEvent(ask: CapabilityAsk, program: string, programSource: string): AskEvent {
	const { file, source, ...asked } = ask;
	const text = file === undefined ? programSource : source;

	return { ...asked, "file": file ?? program, ...text === undefined ? {} : { "source": text } };
}

export function decideControl(answer: DecideRequest): Extract<Control, { "type": "decide" }> {
	const { verdict, value, policy, decided } = answer;

	return { "type": "decide", ...policy === undefined ? {} : { "policy": policy }, "deny": verdict === "deny", "skip": verdict === "skip", ...verdict === "give" ? { "give": value ?? null } : {}, ...decided === undefined ? {} : { "decided": decided } };
}
