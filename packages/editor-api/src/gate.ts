/**
 * How a program's gated call goes by the policy — the one rule tsval's interpreter (debug-worker.ts) and the runtime's
 * files (runtime-fs.ts, any debugger's) both decide by: skipped where the policy skips it; in a live run (retyping
 * mustn't touch the world) nothing made but a read the policy allows; otherwise made if allowed, else refused. Pure.
 */
import type { Policy } from "@brianjenkins94/util/silo/policy";
import { effectiveDisposition, isDangerous } from "@brianjenkins94/util/silo/policy";

export type Verdict = "allow" | "skip" | "deny";

export function verdictOf(policy: Policy | undefined, capability: string, resource: string, live = false): Verdict {
	const disposition = policy === undefined ? undefined : effectiveDisposition(policy, capability, resource, isDangerous(capability));

	if (disposition === "skip" || (live && !(disposition === "allow" && capability === "fs:read"))) {
		return "skip";
	}

	return disposition === "allow" ? "allow" : "deny";
}
