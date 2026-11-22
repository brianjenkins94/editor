/**
 * Capabilities that shrink as well as grow: an allow rule in the policy is confirmed by the runs that use it. One that no test run
 * kept here has used, over enough of them to say, is a problem on the rule, in Problems, with a quick fix that takes it out
 * (packages/silo/README.md: "The join allows what no run used"). It's a person's to remove: code may need it where no test goes,
 * an error's path, say. Runs only say what ran, so a rule about anything but a call's capability and resource isn't judged.
 *
 * What a run used comes from its record (test-runs.ts), read again as each ends. And whether the code could still make the
 * call at all: what each of the workspace's code files can do (lib's `detect`, a scan of its text — a capability, never what
 * it reaches), read once a rule goes unused. None that can, and the rule is likely left over (a dependency's call may still
 * need it: what a package can do is the baseline's); a file that can, and it's a test that reaches it that's missing.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { Policy, Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import type * as vscodeApi from "vscode";
import type { RunRecord } from "./test-runs";
import { createRpcClient } from "@brianjenkins94/hub";
import { detect, refine } from "@brianjenkins94/util/silo/detect";
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

/** Whether `when` holds of a call of `capability` whose resource isn't known: true, false, or undefined for either (a row
 *  about the resource could go both ways). */
function holdsOf(when: Predicate, then: Rule["then"], capability: string): boolean | undefined {
	if (!("predicates" in when)) {
		return when.target_id === "capability"
			? ruleMatches({ "when": when, "then": then }, { "capability": capability })
			: undefined;
	}

	const each = when.predicates.map((predicate) => holdsOf(predicate, then, capability));

	if (when.logicalType_id === "any") {
		return each.includes(true) ? true : each.includes(undefined) ? undefined : false;
	}

	if (when.logicalType_id === "none") {
		return each.includes(true) ? false : each.includes(undefined) ? undefined : true;
	}

	return each.includes(false) ? false : each.includes(undefined) ? undefined : true;
}

/** The code files (of `capabilities`, each one's as `detect` reads its text) that could make a call `rule` allows. */
export function callersOf(rule: Rule, capabilities: Map<string, string[]>): string[] {
	return [...capabilities].filter(([, can]) => can.some((capability) => holdsOf(rule.when, rule.then, capability) !== false)).map(([file]) => file).toSorted();
}

/** What a rule no run has used says, given the files whose code could make the call it allows (undefined: not read). */
export function sayUnconfirmed(runs: number, callers: string[] | undefined): string {
	const unused = `No test run has used this allow rule: ${String(runs)} kept since it was added`;

	if (callers === undefined) {
		return `${unused}. Take it out if the code no longer needs it.`;
	}

	return callers.length === 0
		? `${unused}, and none of the workspace's own code can make the call. Take it out, unless a dependency's call needs it.`
		: `${unused}, but ${callers[0]}${callers.length > 1 ? ` and ${String(callers.length - 1)} more` : ""} can make the call: a test that reaches it would confirm it.`;
}

/** What each code file can do as last read, by its path, kept while its modification time and size stay as they were. */
const known = new Map<string, { "mtime": number; "size": number; "can": string[] }>();

/**
 * Each of the workspace's code files under `root` (not node_modules, a dot-folder or a declaration file) — or of `files`,
 * when the caller has listed them already (relative to `root`) — that can do anything, and what its text says it can do
 * (lib's `detect`); a file is read again only once it's changed (`known`). `files`, how many there are; `read`, how many
 * were read this time.
 */
export async function capabilitiesOf(vscode: typeof vscodeApi, root: string, files?: string[]): Promise<{ "capabilities": Map<string, string[]>; "files": number; "read": number }> {
	const uris = (files === undefined
		? await vscode.workspace.findFiles("**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}", "{**/node_modules/**,**/.*/**}")
		: files.map((file) => vscode.Uri.file(`${root}/${file}`))).filter((uri) => !/\.d\.[cm]?ts$/u.test(uri.path));
	let read = 0;
	const each = await Promise.all(uris.map(async (uri): Promise<[string, string[]]> => {
		const path = uri.path.slice(root.length + 1);
		const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
		const kept = known.get(path);

		if (stat === undefined) {
			return [path, []];
		}

		if (kept?.mtime === stat.mtime && kept.size === stat.size) {
			return [path, kept.can];
		}

		read += 1;

		const can = await Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => refine(detect(new TextDecoder().decode(bytes))), () => []);

		known.set(path, { "mtime": stat.mtime, "size": stat.size, "can": can });

		return [path, can];
	}));

	return { "capabilities": new Map(each.filter(([, can]) => can.length > 0)), "files": uris.length, "read": read };
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
		// (what the code can do, read only once a rule's gone unused: every code file of the workspace)
		let capabilities: Map<string, string[]> | undefined;
		let read: number | undefined;

		problems.clear();

		for (const uri of await policyFiles()) {
			const text = await textOf(uri);

			if (text !== undefined) {
				const document = await vscode.workspace.openTextDocument(uri);
				// (each rule's own `when`: a rule's conditions nest under `predicates`, with no other)
				const starts = [...text.matchAll(/"when"/gu)].map((match) => match.index);

				const found = unconfirmed(parsePolicy(text), history);

				count += found.length;

				if (found.length > 0) {
					if (capabilities === undefined) {
						({ capabilities, read } = await capabilitiesOf(vscode, ROOT));
					}
				}

				const can = capabilities;

				problems.set(uri, found.map(({ rule, index, runs }) => {
					const at = document.positionAt(starts[index] ?? 0);
					const callers = can === undefined ? undefined : callersOf(rule, can);
					const problem = new vscode.Diagnostic(new vscode.Range(at, at.translate(0, 6)), sayUnconfirmed(runs, callers), vscode.DiagnosticSeverity.Information);

					problem.source = "capabilities";
					problem.code = index;
					// (each file that can, a click away)
					problem.relatedInformation = (callers ?? []).slice(0, 20).map((file) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(`${ROOT}/${file}`), new vscode.Position(0, 0)), `can make the call: ${(can?.get(file) ?? []).filter((capability) => holdsOf(rule.when, rule.then, capability) !== false).join(", ")}`));

					return problem;
				}));
			}
		}

		span.end({ "count": count, "runs": history.length, ...read === undefined ? {} : { "read": read } });
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
