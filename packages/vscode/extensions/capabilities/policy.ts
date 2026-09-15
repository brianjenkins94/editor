/**
 * Capability policy — the vscode I/O half (read/write the workspace `.capabilities.json`). The PURE model (types,
 * disposition logic, rule edits, resource matching) lives in policy-core.ts so the runtime enforcer (enforce.ts,
 * which runs inside the almostnode worker, no vscode) governs by the exact same rules the panel shows.
 *
 * Policy-as-code on purpose: the file is at the workspace root, human-readable, shows up in the explorer, and is
 * reviewable in git — the disposition of every capability the code reaches, tracked alongside it.
 */
import * as vscode from "vscode";

import { EMPTY_POLICY, parsePolicy, type Policy } from "./policy-core";

export { effectiveDisposition, withRule, withoutRule } from "./policy-core";
export type { Disposition, Effective, Policy, Rule } from "./policy-core";

/** The `.capabilities.json` at the (first) workspace root, or undefined with no workspace open. */
export function policyUri(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];

	return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ".capabilities.json");
}

/** Read + parse the policy file, tolerating an absent or malformed file (→ empty policy). */
export async function readPolicy(uri: vscode.Uri | undefined): Promise<Policy> {
	if (uri === undefined) {
		return { ...EMPTY_POLICY };
	}

	try {
		const bytes = await vscode.workspace.fs.readFile(uri);

		return parsePolicy(new TextDecoder().decode(bytes));
	} catch (error) {
		return { ...EMPTY_POLICY };
	}
}

/** Write the policy file (pretty-printed, trailing newline — it's meant to be read + diffed by humans). */
export async function writePolicy(uri: vscode.Uri, policy: Policy): Promise<void> {
	const text = JSON.stringify(policy, undefined, "\t") + "\n";

	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}
