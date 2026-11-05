/**
 * Capabilities that shrink as well as grow: an allow rule in the policy is confirmed by the runs that use it. One that no test run
 * kept here has used, over enough of them to say, is a problem on the rule, in Problems, with a quick fix that takes it out
 * (packages/silo/README.md: "The join allows what no run used"). It's a person's to remove: code may need it where no test goes,
 * an error's path, say. Runs only say what ran, so a rule about anything but a call's capability and resource isn't judged.
 *
 * What a run used comes from its record (test-runs.ts), read again as each ends. The other half, whether the code could still
 * make the call at all, comes back with the static analysis (*Capability findings in the code*).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { Policy, Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import type * as vscodeApi from "vscode";
import type { RunRecord } from "./test-runs";
import { createRpcClient } from "@brianjenkins94/hub";
import { parsePolicy, ruleMatches } from "@brianjenkins94/util/silo/policy";

const ROOT = "/workspace";

/** How many test runs since a rule was added before its not being used says anything. */
const ENOUGH_RUNS = 5;

/** The targets a rule's conditions name. */
function targetsOf(when: Predicate): string[] {
	return "predicates" in when ? when.predicates.flatMap(targetsOf) : [when.target_id];
}

const allows = (rule: Rule): boolean => rule.then.some((action) => action.action_id === "allow");

/** Whether runs can say anything about `rule`: an allow, about a call's capability and resource alone. */
const judged = (rule: Rule): boolean => allows(rule) && targetsOf(rule.when).every((target) => target === "capability" || target === "resource");

/** The rules of `policy` no run in `history` used, once enough have run since each was added. */
export function unconfirmed(policy: Policy, history: RunRecord[]): { "rule": Rule; "index": number; "runs": number }[] {
	return policy.rules.flatMap((rule, index) => {
		if (!judged(rule)) {
			return [];
		}

		const since = history.filter((run) => rule.added === undefined || run.at >= rule.added);
		const used = since.some((run) => run.effects.some((effect) => effect.how !== "denied" && effect.how !== "skipped" && ruleMatches(rule, { "capability": effect.capability, "resource": effect.resource })));

		return !used && since.length >= ENOUGH_RUNS ? [{ "rule": rule, "index": index, "runs": since.length }] : [];
	});
}

export function installCapabilityConfirm(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	const rpc = createRpcClient(hub);
	const problems = vscode.languages.createDiagnosticCollection("capabilities-confirmed");
	const textOf = async (uri: vscodeApi.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
	const policyFiles = async (): Promise<vscodeApi.Uri[]> => {
		const folder = vscode.Uri.file(`${ROOT}/.silo/policy`);
		const mine = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).catch(() => [] as [string, vscodeApi.FileType][]);

		return [vscode.Uri.file(`${ROOT}/.silo/policy.json`), ...mine.filter(([name]) => name.endsWith(".json")).map(([name]) => vscode.Uri.joinPath(folder, name))];
	};

	const check = async (): Promise<void> => log.span("editor.workbench.capability-confirm.check", {}, async (span) => {
		const { history } = await rpc.request("tests.history", {}, { "timeoutMs": 60_000, "waitForResponderMs": 60_000 }) as { "history": RunRecord[] };
		let count = 0;

		problems.clear();

		for (const uri of await policyFiles()) {
			const text = await textOf(uri);

			if (text !== undefined) {
				const document = await vscode.workspace.openTextDocument(uri);
				// (each rule's own `when`: a rule's conditions nest under `predicates`, with no other)
				const starts = [...text.matchAll(/"when"/gu)].map((match) => match.index);

				const found = unconfirmed(parsePolicy(text), history);

				count += found.length;
				problems.set(uri, found.map(({ index, runs }) => {
					const at = document.positionAt(starts[index] ?? 0);
					const problem = new vscode.Diagnostic(new vscode.Range(at, at.translate(0, 6)), `No test run has used this allow rule: ${String(runs)} kept since it was added. Take it out if the code no longer needs it.`, vscode.DiagnosticSeverity.Information);

					problem.source = "capabilities";
					problem.code = index;

					return problem;
				}));
			}
		}

		span.end({ "count": count, "runs": history.length });
	});

	vscode.languages.registerCodeActionsProvider({ "pattern": "**/.silo/{policy.json,policy/*.json}" }, {
		"provideCodeActions": (document, _range, context) => context.diagnostics.filter((problem) => problem.source === "capabilities").map((problem) => {
			const action = new vscode.CodeAction("Take this rule out", vscode.CodeActionKind.QuickFix);
			const policy = parsePolicy(document.getText());

			action.diagnostics = [problem];
			action.edit = new vscode.WorkspaceEdit();
			action.edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), JSON.stringify({ ...policy, "rules": policy.rules.filter((_, index) => index !== problem.code) }, null, 2) + "\n");

			return action;
		})
	}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] });

	hub.subscribe("tests.kept", () => {
		void check();
	});
	vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.uri.path.includes("/.silo/policy")) {
			void check();
		}
	});
	void check();
}
