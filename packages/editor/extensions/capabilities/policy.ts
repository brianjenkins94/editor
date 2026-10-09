/**
 * Capability policy — the vscode I/O half (read/write the workspace `.silo/policy.json`). The PURE model (types,
 * disposition logic, rule edits, resource matching) lives in silo's shared policy layer
 * (`@brianjenkins94/util/silo/policy`) so the runtime enforcer (silo-store.ts, consulted by decide.ts) — and any
 * other silo harness — governs by the exact same rules the panel shows.
 *
 * This panel edits the BASE policy — the shared, human-authored contract at `.silo/policy.json`. A person clicking
 * a disposition here IS the human authoring it (silo itself never writes this file). Per-user runtime grants (the
 * "Allow always" popup) land separately in `.silo/<user>.policy.json`, which the enforcer layers ON TOP of this
 * base; the enforcer sees the merge, this panel curates the contract half.
 *
 * Policy-as-code on purpose: the file is under `.silo/`, human-readable, shows up in the explorer, and is
 * reviewable in git — the disposition of every capability the code reaches, tracked alongside it.
 */
import * as vscode from "vscode";

import { EMPTY_POLICY, parsePolicy, type Policy } from "@brianjenkins94/util/silo/policy";

export { effectiveDisposition, withRule, withoutRule } from "@brianjenkins94/util/silo/policy";
export type { Disposition, Effective, Policy, Rule } from "@brianjenkins94/util/silo/policy";

/** The base `.silo/policy.json` at the (first) workspace root, or undefined with no workspace open. */
export function policyUri(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];

	return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ".silo", "policy.json");
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

/** Write the policy file (pretty-printed, trailing newline — it's meant to be read + diffed by humans). Ensures
 *  the `.silo/` directory exists (a first panel edit may create the layout). */
export async function writePolicy(uri: vscode.Uri, policy: Policy): Promise<void> {
	const text = JSON.stringify(policy, undefined, "\t") + "\n";

	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}
