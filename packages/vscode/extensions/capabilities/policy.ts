/**
 * Capability policy — the THIRD column (dispositions). A workspace `.capabilities.json` records, per capability +
 * resource, what the developer decided: `allow` or `deny`. Anything dangerous without a rule is `review` (a
 * computed default, never stored) — the governance signal "you haven't decided about this yet". Non-dangerous
 * calls default to `allow`.
 *
 * Policy-as-code on purpose: the file lives at the workspace root, is human-readable, shows up in the explorer,
 * and is reviewable in git — the disposition of every capability the code reaches, tracked alongside it. M0
 * governs by surfacing (allow/deny/review in the panel + a badge); `gate`/`mock` and real runtime enforcement
 * (blocking or substituting a call when the code actually runs) come with the runtime tripwire.
 */
import * as vscode from "vscode";

/** A stored decision. `review` is never stored — it's the computed default for an undecided dangerous call. */
export type Disposition = "allow" | "deny";
/** The effective disposition shown in the UI (stored decision, or the computed default). */
export type Effective = Disposition | "review";

export interface Rule {
	"capability": string;
	"resource": string;
	"disposition": Disposition;
}

export interface Policy {
	"version": number;
	"rules": Rule[];
}

const EMPTY: Policy = { "version": 1, "rules": [] };

/** The `.capabilities.json` at the (first) workspace root, or undefined with no workspace open. */
export function policyUri(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];

	return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ".capabilities.json");
}

/** Read + parse the policy file, tolerating an absent or malformed file (→ empty policy). */
export async function readPolicy(uri: vscode.Uri | undefined): Promise<Policy> {
	if (uri === undefined) {
		return { ...EMPTY };
	}

	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Policy>;

		return { "version": parsed.version ?? 1, "rules": Array.isArray(parsed.rules) ? parsed.rules : [] };
	} catch (error) {
		return { ...EMPTY };
	}
}

/** Write the policy file (pretty-printed, trailing newline — it's meant to be read + diffed by humans). */
export async function writePolicy(uri: vscode.Uri, policy: Policy): Promise<void> {
	const text = JSON.stringify(policy, undefined, "\t") + "\n";

	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/** The effective disposition for a call: an explicit rule wins; otherwise dangerous → review, safe → allow. */
export function effectiveDisposition(policy: Policy, capability: string, resource: string, dangerous: boolean): Effective {
	const rule = policy.rules.find((candidate) => candidate.capability === capability && candidate.resource === resource);

	if (rule !== undefined) {
		return rule.disposition;
	}

	return dangerous ? "review" : "allow";
}

/** Return a copy of `policy` with the (capability, resource) rule set to `disposition` (replacing any existing). */
export function withRule(policy: Policy, capability: string, resource: string, disposition: Disposition): Policy {
	const rules = policy.rules.filter((rule) => !(rule.capability === capability && rule.resource === resource));

	rules.push({ "capability": capability, "resource": resource, "disposition": disposition });
	rules.sort((a, b) => (a.capability + a.resource).localeCompare(b.capability + b.resource));

	return { "version": policy.version, "rules": rules };
}

/** Return a copy of `policy` with any (capability, resource) rule removed (→ back to the computed default). */
export function withoutRule(policy: Policy, capability: string, resource: string): Policy {
	return { "version": policy.version, "rules": policy.rules.filter((rule) => !(rule.capability === capability && rule.resource === resource)) };
}
