import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages } from "@brianjenkins94/util/silo/evidence";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import { keptAt, localOf } from "@brianjenkins94/editor-api/git";
import { loadPolicyFiles, replaceRule } from "@brianjenkins94/editor-api/policy";
import { baselinePath, checked, VERSIONS, versionsPath } from "@brianjenkins94/util/silo/layout";
import * as policy from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { POLICY_FILES } from "./decisions";

interface BaselineFile { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages }

interface Grown { "name": string; "capability": string; "by": string }

const CODE = "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

function packageOf(spec: string): string {
	return spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
}

function keyIn(document: vscode.TextDocument, name: string): vscode.Range | undefined {
	const at = document.getText().indexOf(`"${name}"`);

	return at === -1 ? undefined : new vscode.Range(document.positionAt(at), document.positionAt(at + name.length + 2));
}

function importsIn(text: string, spec: string): vscode.Range[] {
	const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
	const pattern = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])${quoted}\1`, "gu");
	const matches = [...text.matchAll(pattern)];

	if (matches.length === 0) {
		return [];
	}

	const starts = [0, ...[...text.matchAll(/\n/gu)].map((match) => match.index + 1)];
	const positionAt = (offset: number): vscode.Position => {
		const line = starts.findLastIndex((start) => start <= offset);

		return new vscode.Position(line, offset - starts[line]);
	};

	return matches.map((match) => {
		const start = match.index + match[0].length - spec.length - 2;

		return new vscode.Range(positionAt(start), positionAt(start + spec.length + 2));
	});
}

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
	const grownOf = new WeakMap<vscode.Diagnostic, Grown>();
	const there = async (path: string): Promise<boolean> => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, path))).then(() => true, () => false);
	const readJson = async (path: string): Promise<unknown> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, path))).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown, () => undefined);

	const check = async (): Promise<void> => {
		const baseline = checked(baselinePath(), await readJson(await keptAt(baselinePath(), there)) as BaselineFile | undefined, VERSIONS.baseline);
		const files = await loadPolicyFiles();
		const all = { ...policy.EMPTY_POLICY, "rules": [...files?.mine.rules ?? [], ...files?.shared.rules ?? []] };
		const undecided = (name: string, capability: string): boolean => policy.effectiveDisposition(all, capability, "", true, { "package": name }) === "review";
		const byUri = new Map<string, { "uri": vscode.Uri; "diagnostics": vscode.Diagnostic[] }>();
		const warn = (uri: vscode.Uri, range: vscode.Range, message: string, grown: Grown): void => {
			const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);

			diagnostic.source = "baseline";
			diagnostic.code = "grew";
			grownOf.set(diagnostic, grown);
			byUri.set(uri.toString(), { "uri": uri, "diagnostics": [...byUri.get(uri.toString())?.diagnostics ?? [], diagnostic] });
		};

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
		const ownerOf = (path: string): { "dir": string; "private": boolean } => workspaces.filter(({ dir }) => dir !== "." && path.startsWith(`${dir}/`)).toSorted((one, other) => other.dir.length - one.dir.length)[0] ?? { "dir": ".", "private": false };

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

		const texts = new Map<string, Promise<{ "uri": vscode.Uri; "text": string }[]>>();
		const textsOf = async (workspace: string): Promise<{ "uri": vscode.Uri; "text": string }[]> => {
			const listed = texts.get(workspace) ?? (async () => {
				const pattern = workspace === "." ? CODE : `${workspace}/${CODE}`;
				const uris = (await vscode.workspace.findFiles(pattern, "{**/node_modules/**,**/.*/**}", 500)).filter((uri) => ownerOf(uri.path.slice(root.path.length + 1)).dir === workspace);

				return Promise.all(uris.map(async (uri) => ({
					"uri": uri,
					"text": vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri.toString())?.getText() ?? await Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "")
				})));
			})();

			texts.set(workspace, listed);

			return listed;
		};

		for (const [workspace, used] of Object.entries(baseline?.consumer ?? {})) {
			for (const [spec, use] of Object.entries(used)) {
				const name = packageOf(spec);
				const grew = Object.entries(use.grew ?? {}).filter(([capability]) => undecided(name, capability));

				if (grew.length === 0) {
					continue;
				}

				for (const { uri, text } of await textsOf(workspace)) {
					for (const range of importsIn(text, spec)) {
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
