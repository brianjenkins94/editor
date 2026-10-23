/**
 * Placed rules beside their code (RUNNING.md, *A rule placed in the code*): a pane view into the editor's Margin
 * (ARCHITECTURE.md, *Extension points* 4) — a gutter mark on the first line of the code each rule placed in the file is at, its
 * sentence on hover (whose, which lines), so a mocked variable or a given result isn't invisible; marked uncertain
 * where it was found by a weak match. The rules and where each is now come from the editor (`silo.rules.list`: its
 * sentence in the catalog's words, its place as the editor found it in the file as it is); drawn again as the policy
 * files change, and as the file does.
 */
import type { PaneContent, PaneMark } from "@brianjenkins94/editor-api/pane";
import { refreshPane } from "@brianjenkins94/editor-api/pane";
import { POLICY_GLOB } from "@brianjenkins94/util/silo/layout";
import { placesOf } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

/** The view's id: its provider is `placedRules.paneView`. */
const VIEW = "placedRules";

/** A rule as the editor lists it: whose, its sentence, what keeps it from matching, and where its place is now. */
interface Listed { "whose": "mine" | "shared"; "sentence": string; "problem"?: string; "place"?: { "status": string; "line"?: number; "endLine"?: number }; "rule": Parameters<typeof placesOf>[0] }

/** The marks for the rules placed in `uri`'s file: one a line, each rule's sentence on it. */
async function placedIn(uri: string): Promise<PaneContent | undefined> {
	const listed = await Promise.resolve(vscode.commands.executeCommand<Listed[] | null>("silo.rules.list")).catch(() => null) ?? [];
	const file = vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false);
	const byLine = new Map<number, { "sentences": string[]; "uncertain": boolean }>();

	for (const { whose, sentence, problem, place, rule } of listed) {
		// (one that can't apply — broken, or its place lost — is the Rules view's to say, not a mark's)
		if (problem === undefined && place?.line !== undefined && place.status !== "orphaned" && (placesOf(rule) as ({ "file"?: string } | undefined)[]).some((each) => each?.file === file)) {
			const end = place.endLine ?? place.line;
			const at = byLine.get(place.line - 1) ?? { "sentences": [], "uncertain": false };

			at.sentences.push(`${whose === "mine" ? "My rule" : "A shared rule"}${end > place.line ? ` (lines ${place.line}–${end})` : ""}: ${sentence}${place.status === "uncertain" ? " — found here by a weak match: open it in the Rules view to confirm or re-place it" : ""}`);
			at.uncertain ||= place.status === "uncertain";
			byLine.set(place.line - 1, at);
		}
	}

	if (byLine.size === 0) {
		return undefined;
	}

	return { "items": [], "marks": [...byLine].map(([line, { sentences, uncertain }]): PaneMark => ({ "at": { "lines": [line, line] }, "kind": uncertain ? "rule-uncertain" : "rule", "title": sentences.join("\n") })) };
}

export function registerPlacedRules(context: vscode.ExtensionContext): void {
	const watcher = vscode.workspace.createFileSystemWatcher(POLICY_GLOB);
	const changed = (): void => {
		void refreshPane(vscode.commands, VIEW);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(`${VIEW}.paneView`, async (uri: unknown) => (typeof uri === "string" ? placedIn(uri) : undefined)),
		watcher,
		watcher.onDidChange(changed),
		watcher.onDidCreate(changed),
		watcher.onDidDelete(changed)
	);
}
