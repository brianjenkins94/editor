/**
 * What grew beyond the dependency baseline, said where it is (no view: the user, 2026-11-06). The baseline (baseline.ts)
 * records what each dependency's own code could do when it was added; what grew since asks at the call until the policy
 * allows it, and is warned here meanwhile:
 *
 * - A newer version that can do more (`packages[name].grew`: each capability with the version that grew it): a warning on
 *   its line in each package.json that depends on it, or, for a package nothing lists (a dependency's dependency), on its
 *   line in the versions the editor resolved (`.silo/versions.json`).
 * - The code's use of a package that reaches more than it did (the join's `grew`: each capability with the members that
 *   brought it in): a warning on each import of it in that workspace's code.
 *
 * The workspaces are the baseline's: each package.json's folder, but a nested private one, which governs itself, and a file
 * is the deepest one's that has it.
 *
 * Each until the policy decides the package's calls of it: its lightbulb's "Allow … always" writes that in your policy
 * (`policy/<you>.json`), about the package (any version) and the capability, and "Refuse" writes its deny — what the
 * call's own prompt would have, ahead of time.
 */
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages } from "@brianjenkins94/util/silo/evidence";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import { keptAt, localOf } from "@brianjenkins94/editor-api/git";
import { loadPolicyFiles, replaceRule } from "@brianjenkins94/editor-api/policy";
import { baselinePath, versionsPath } from "@brianjenkins94/util/silo/layout";
import * as policy from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { POLICY_FILES } from "./decisions";

/** What `.silo/baseline.json` holds, as far as growth goes. */
interface BaselineFile { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages }

/** One growth to warn of: the package, the capability, and what grew it. */
interface Grown { "name": string; "capability": string; "by": string }

/** Code files, as the consumer reads them. */
const CODE = "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

/** The package a specifier is of: `@scope/name` or `name`, before any subpath. */
function packageOf(spec: string): string {
	return spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
}

/** `text`'s first `"name"` key's string, as a range in `document`; undefined when it has none. */
function keyIn(document: vscode.TextDocument, name: string): vscode.Range | undefined {
	const at = document.getText().indexOf(`"${name}"`);

	return at === -1 ? undefined : new vscode.Range(document.positionAt(at), document.positionAt(at + name.length + 2));
}

/** Each import of `spec` in `document`: the specifier's string, as a range. */
function importsIn(document: vscode.TextDocument, spec: string): vscode.Range[] {
	const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
	const pattern = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])${quoted}\1`, "gu");

	return [...document.getText().matchAll(pattern)].map((match) => {
		const start = match.index + match[0].length - spec.length - 2;

		return new vscode.Range(document.positionAt(start), document.positionAt(start + spec.length + 2));
	});
}

/** A rule deciding `name`'s calls of `capability`, whatever they reach. */
function packageRule(name: string, capability: string, disposition: "allow" | "deny"): Rule {
	return {
		"when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": capability }, { "target_id": "package", "operator_id": "is", "argument": name }] },
		"then": [{ "action_id": disposition }]
	} as Rule;
}

export function warnGrowth(context: vscode.ExtensionContext, log?: ObservedExtension["log"]): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;

	if (root === undefined) {
		return;
	}

	const diagnostics = vscode.languages.createDiagnosticCollection("baseline");
	/** Each diagnostic's growth, for its lightbulb. */
	const grownOf = new WeakMap<vscode.Diagnostic, Grown>();
	const there = async (path: string): Promise<boolean> => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, path))).then(() => true, () => false);
	const readJson = async (path: string): Promise<unknown> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, path))).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown, () => undefined);

	const check = async (): Promise<void> => {
		const baseline = await readJson(await keptAt(baselinePath(), there)) as BaselineFile | undefined;
		const files = await loadPolicyFiles();
		const all = { ...policy.EMPTY_POLICY, "rules": [...files?.mine.rules ?? [], ...files?.shared.rules ?? []] };
		// (grown, and not yet decided: the policy would still ask about the package's calls of it)
		const undecided = (name: string, capability: string): boolean => policy.effectiveDisposition(all, capability, "", true, { "package": name }) === "review";
		const byUri = new Map<string, { "uri": vscode.Uri; "diagnostics": vscode.Diagnostic[] }>();
		const warn = (uri: vscode.Uri, range: vscode.Range, message: string, grown: Grown): void => {
			const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);

			diagnostic.source = "baseline";
			diagnostic.code = "grew";
			grownOf.set(diagnostic, grown);
			byUri.set(uri.toString(), { "uri": uri, "diagnostics": [...byUri.get(uri.toString())?.diagnostics ?? [], diagnostic] });
		};

		// The workspaces, as the baseline has them: each package.json's folder ("." the root's), a nested private one left out.
		const workspaces = await Promise.all((await vscode.workspace.findFiles("**/package.json", "{**/node_modules/**,**/.*/**}")).map(async (uri) => {
			const document = await vscode.workspace.openTextDocument(uri);
			const dir = uri.path.slice(root.path.length + 1, -"package.json".length).replace(/\/$/u, "") || ".";
			const manifest = (() => {
				try {
					return JSON.parse(document.getText()) as { "private"?: unknown };
				} catch {
					return undefined;
				}
			})();

			return { "dir": dir, "private": dir !== "." && manifest?.private === true, "document": document };
		}));
		const manifests = workspaces.filter((each) => !each.private).map(({ document }) => document);
		/** The workspace a workspace-relative path is in: the deepest folder with a package.json that has it. */
		const ownerOf = (path: string): { "dir": string; "private": boolean } => workspaces.filter(({ dir }) => dir !== "." && path.startsWith(`${dir}/`)).toSorted((one, other) => other.dir.length - one.dir.length)[0] ?? { "dir": ".", "private": false };

		// A newer version that can do more: on its dependency's line.
		const versionsUri = vscode.Uri.joinPath(root, await keptAt(versionsPath(), there));
		const versions = await Promise.resolve(vscode.workspace.openTextDocument(versionsUri)).catch(() => undefined);

		for (const [name, entry] of Object.entries(baseline?.packages ?? {})) {
			const grew = Object.entries(entry.grew ?? {}).filter(([capability]) => undecided(name, capability));

			if (grew.length > 0) {
				const listing = manifests.map((document) => ({ "document": document, "range": keyIn(document, name) })).filter(({ range }) => range !== undefined);
				const listed = listing.length > 0 || versions === undefined ? listing : [{ "document": versions, "range": keyIn(versions, name) }];

				for (const [capability, version] of grew) {
					for (const { document, range } of listed) {
						if (range !== undefined) {
							warn(document.uri, range, `${name} ${entry.version} can do more than when it was added: ${capability}, since ${version}. Its calls of it ask at the call until your policy decides them.`, { "name": name, "capability": capability, "by": version });
						}
					}
				}
			}
		}

		// The code's use that reaches more: on each import of it in that workspace's code.
		for (const [workspace, used] of Object.entries(baseline?.consumer ?? {})) {
			for (const [spec, use] of Object.entries(used)) {
				const name = packageOf(spec);
				const grew = Object.entries(use.grew ?? {}).filter(([capability]) => undecided(name, capability));

				if (grew.length === 0) {
					continue;
				}

				const pattern = workspace === "." ? CODE : `${workspace}/${CODE}`;

				for (const uri of await vscode.workspace.findFiles(pattern, "{**/node_modules/**,**/.*/**}", 500)) {
					// (another workspace's file: its own use, in its own entry, or a private one's, not the baseline's)
					if (ownerOf(uri.path.slice(root.path.length + 1)).dir !== workspace) {
						continue;
					}

					const document = await vscode.workspace.openTextDocument(uri);

					for (const range of importsIn(document, spec)) {
						for (const [capability, by] of grew) {
							warn(uri, range, `Your use of ${spec} reaches more than it did: ${capability}${by === "*" ? "" : `, from ${by}`}. Its calls of it ask at the call until your policy decides them.`, { "name": name, "capability": capability, "by": by });
						}
					}
				}
			}
		}

		diagnostics.clear();

		for (const { uri, "diagnostics": found } of byUri.values()) {
			diagnostics.set(uri, found);
		}
	};

	let checking: Promise<void> = Promise.resolve();
	const recheck = (): void => {
		checking = checking.then(async () => (log === undefined ? check() : log.span("editor.extensions.capabilities.growth.check", {}, check))).catch((error: unknown) => {
			log?.warn("what grew beyond the baseline couldn't be said", { "error": String(error) });
		});
	};

	// (the baseline, wherever it's kept, and the policy: what's grown, and what's decided)
	const watchers = [vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `{${baselinePath()},${localOf(baselinePath())}}`)), vscode.workspace.createFileSystemWatcher(POLICY_FILES)];

	context.subscriptions.push(
		diagnostics,
		...watchers,
		...watchers.flatMap((watcher) => [watcher.onDidCreate(recheck), watcher.onDidChange(recheck), watcher.onDidDelete(recheck)]),
		vscode.commands.registerCommand("capabilities.decideGrowth", async (grown: Grown, disposition: "allow" | "deny") => {
			const decide = async (): Promise<void> => replaceRule(undefined, packageRule(grown.name, grown.capability, disposition));

			await (log === undefined ? decide() : log.span("editor.extensions.capabilities.growth.decide", { "op": disposition, "capability": grown.capability }, decide));
			recheck();
		}),
		vscode.languages.registerCodeActionsProvider([{ "scheme": "file" }], {
			"provideCodeActions": (_document, _range, { "diagnostics": here }) => here.flatMap((diagnostic) => {
				const grown = grownOf.get(diagnostic);

				if (grown === undefined) {
					return [];
				}

				return (["allow", "deny"] as const).map((disposition) => {
					const title = disposition === "allow" ? `Allow ${grown.name}'s ${grown.capability}, always` : `Refuse ${grown.name}'s ${grown.capability}`;
					const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

					action.command = { "title": title, "command": "capabilities.decideGrowth", "arguments": [grown, disposition] };
					action.diagnostics = [diagnostic];

					return action;
				});
			})
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] })
	);
	recheck();
}
