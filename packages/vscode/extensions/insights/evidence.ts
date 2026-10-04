/**
 * The runtime evidence kept for a file, as the insights surfaces show it (RUNTIME-EVIDENCE.md): every user's runs in
 * every environment (`.silo/evidence/<user>/<environment>/<file>.jsonl`) folded together, and this machine's samples
 * of the values themselves (`.silo/local/samples/<file>.jsonl`). Read where the layout puts them, rather than searched
 * for, and again when they change.
 *
 * Evidence is an observed span annotation (SPAN-ANNOTATIONS.md): each span is found in the document as it is now by the
 * editor's BABLR, by its id alone (worker-pod's `editor.annotations.resolve`), and one that isn't there fades rather
 * than being looked for. A file BABLR's grammar doesn't take yet has none.
 */
import type { Resolution } from "@brianjenkins94/util/silo/annotations";
import type { Observation } from "@brianjenkins94/util/silo/evidence";
import { observedRef } from "@brianjenkins94/util/silo/annotations";
import { LOCAL_DIR, parseEvidence, parseSamples, SILO_DIR } from "@brianjenkins94/util/silo/evidence";
import * as vscode from "vscode";

/** What every run observed at one span, folded: strict counts summed, faded runs summed, the latest report's time. */
export interface SpanEvidence {
	"reached"?: { "ever": number; "runs": number; "lastAt": string };
	"value"?: { "seen": number; "nullish": number; "tags": Record<string, number>; "ever": number; "runs": number; "lastAt": string };
	"branch"?: { "arms": number[]; "ever": number; "runs": number; "lastAt": string };
	/** A few of the values themselves, as this machine saw them. */
	"samples"?: (string | number | boolean)[];
}

/** A span with evidence, where it is in the document now: offsets, and its node type when BABLR said. */
export interface Placed { "start": number; "end": number; "type"?: string; "evidence": SpanEvidence }

export interface EvidenceStore {
	/** The evidence placed in `document` as it is now; undefined when it was edited while being placed (a newer look
	 *  follows). Empty when there's none, or no editor BABLR to place it. */
	"placed": (document: vscode.TextDocument) => Promise<Placed[] | undefined>;
	/** A file's evidence (or samples) changed: the workspace-relative path. */
	"onDidChange": vscode.Event<string>;
}

/** `observation` added to what's known of its span. */
function fold(known: SpanEvidence, observation: Observation): SpanEvidence {
	const latest = (a: string | undefined, b: string): string => (a !== undefined && a > b ? a : b);

	switch (observation.kind) {
		case "reached": {
			const before = known.reached;

			return { ...known, "reached": { "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
		}

		case "value": {
			const before = known.value;
			const tags = { ...before?.tags };

			for (const [tag, count] of Object.entries(observation.tags)) {
				tags[tag] = (tags[tag] ?? 0) + count;
			}

			return { ...known, "value": { "seen": (before?.seen ?? 0) + observation.seen, "nullish": (before?.nullish ?? 0) + observation.nullish, "tags": tags, "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
		}

		case "branch": {
			const before = known.branch;
			const arms = Array.from({ "length": Math.max(before?.arms.length ?? 0, observation.arms.length) }, (_, arm) => (before?.arms[arm] ?? 0) + (observation.arms[arm] ?? 0));

			return { ...known, "branch": { "arms": arms, "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
		}

		default:
			return known;
	}
}

export function evidenceStore(context: vscode.ExtensionContext): EvidenceStore {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
	const text = async (uri: vscode.Uri): Promise<string> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "");
	const folders = async (uri: vscode.Uri): Promise<string[]> => Promise.resolve(vscode.workspace.fs.readDirectory(uri)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => []);
	/** Each file's evidence, by workspace-relative path: read when first wanted, again when it changes. */
	const byFile = new Map<string, Promise<Map<string, SpanEvidence>>>();
	/** Each document's placed evidence, for the version it was placed in: the gutter and the hover share one placing. */
	const placings = new Map<string, { "version": number; "placed": Promise<Placed[] | undefined> }>();
	const changed = new vscode.EventEmitter<string>();

	const evidenceOf = (file: string): Promise<Map<string, SpanEvidence>> => {
		let known = byFile.get(file);

		if (known === undefined) {
			known = (async () => {
				const bySpan = new Map<string, SpanEvidence>();
				const evidence = vscode.Uri.joinPath(root, `${SILO_DIR}/evidence`);

				for (const user of await folders(evidence)) {
					for (const environment of await folders(vscode.Uri.joinPath(evidence, user))) {
						for (const observation of parseEvidence(await text(vscode.Uri.joinPath(evidence, user, environment, `${file}.jsonl`)))) {
							bySpan.set(observation.span, fold(bySpan.get(observation.span) ?? {}, observation));
						}
					}
				}

				for (const { span, values } of parseSamples(await text(vscode.Uri.joinPath(root, `${LOCAL_DIR}/samples/${file}.jsonl`)))) {
					const known = bySpan.get(span);

					if (known !== undefined) {
						known.samples = values;
					}
				}

				return bySpan;
			})().catch(() => new Map<string, SpanEvidence>());
			byFile.set(file, known);
		}

		return known;
	};

	const place = async (document: vscode.TextDocument): Promise<Placed[] | undefined> => {
		const file = vscode.workspace.asRelativePath(document.uri, false);
		const known = await evidenceOf(file);

		if (known.size === 0) {
			return [];
		}

		const version = document.version;
		const spans = [...known.keys()];
		const found = await Promise.resolve(vscode.commands.executeCommand<Resolution[] | undefined>("editor.annotations.resolve", document.getText(), file, spans.map((span) => observedRef(span, file)), { "observed": true })).catch(() => undefined);

		if (document.version !== version) {
			return undefined;
		}

		// Found here (lost — or moved to another file — it fades: new runs make new evidence).
		return spans.flatMap((span, index) => {
			const at = found?.[index]?.candidate;

			return at?.start === undefined || at.end === undefined || at.file !== file ? [] : [{ "start": at.start, "end": at.end, ...at.type === undefined ? {} : { "type": at.type }, "evidence": known.get(span)! }];
		});
	};

	const watchers = [`**/${SILO_DIR}/evidence/**/*.jsonl`, `**/${LOCAL_DIR}/samples/**/*.jsonl`].map((glob) => vscode.workspace.createFileSystemWatcher(glob));
	const onChange = (uri: vscode.Uri): void => {
		// `.silo/evidence/<user>/<environment>/<file>.jsonl` or `.silo/local/samples/<file>.jsonl` → <file>
		const file = /\/\.silo\/(?:evidence\/[^/]+\/[^/]+|local\/samples)\/(.+)\.jsonl$/u.exec(uri.path)?.[1];

		if (file !== undefined) {
			byFile.delete(file);
			placings.clear();
			changed.fire(file);
		}
	};

	context.subscriptions.push(changed, ...watchers, ...watchers.flatMap((watcher) => [watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange)]));

	return {
		"placed": async (document) => {
			const key = document.uri.toString();
			let placing = placings.get(key);

			if (placing?.version !== document.version) {
				placing = { "version": document.version, "placed": place(document) };
				placings.set(key, placing);
			}

			return placing.placed;
		},
		"onDidChange": changed.event
	};
}
