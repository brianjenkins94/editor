/**
 * How a program's gated call goes by the policy — the one rule tsval's interpreter (debug-worker.ts) and the runtime's
 * files (runtime-fs.ts, any debugger's) both decide by: skipped where the policy skips it; in a live run (retyping
 * mustn't touch the world) nothing made but a read the policy allows; otherwise made if allowed, else refused. Pure.
 */
import type { Policy, Trigger } from "@brianjenkins94/util/silo/policy";
import { effectiveDisposition, isDangerous } from "@brianjenkins94/util/silo/policy";

export type Verdict = "allow" | "skip" | "deny";

/** Who started a run, as a rule matches it (`trigger`): a live run is the editor's, after an edit; any other, yours. */
export const triggerOf = (live: boolean): Trigger => (live ? "edit" : "you");

export function verdictOf(policy: Policy | undefined, capability: string, resource: string, live = false): Verdict {
	const disposition = policy === undefined ? undefined : effectiveDisposition(policy, capability, resource, isDangerous(capability), { "trigger": triggerOf(live) });

	if (disposition === "skip" || (live && !(disposition === "allow" && capability === "fs:read"))) {
		return "skip";
	}

	return disposition === "allow" ? "allow" : "deny";
}

/** Whether the policy itself skips the call (a rule's *then skip*), as opposed to a live run skipping what it can't make. */
export function policySkips(policy: Policy | undefined, capability: string, resource: string, live = false): boolean {
	return policy !== undefined && effectiveDisposition(policy, capability, resource, isDangerous(capability), { "trigger": triggerOf(live) }) === "skip";
}
