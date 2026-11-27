/**
 * The runtime evidence kept for a file, as the insights surfaces show it (RUNTIME-EVIDENCE.md): this machine's runs,
 * every count (`.silo/local/evidence/<user>/<environment>/<file>.jsonl`), and every other user's and environment's as
 * committed (`.silo/evidence/…`, what was seen: util's `stableOf`), folded together — `coarse` where any of it is a
 * committed line, which says what ran and how, and on how many runs at least, not how often — and this machine's
 * samples of the values themselves (`.silo/local/samples/<file>.jsonl`). Read where the layout puts them, rather than searched
 * for, and again when they change.
 *
 * Evidence is an observed span annotation (packages/editor/RUNTIME-EVIDENCE.md, *Durable annotations on spans*): each span is found in the document as it is now by the
 * editor's BABLR, by its id alone (the bridge's `editor.annotations.resolve`), and one that isn't there fades rather
 * than being looked for. A file BABLR's grammar doesn't take yet has none.
 */
import type { Observation } from "@brianjenkins94/util/silo/evidence";
import type * as vscodeApi from "vscode";
import { observedRef } from "@brianjenkins94/util/silo/annotations";
import type { StableChange, StableObservation } from "@brianjenkins94/util/silo/evidence";
import { parseEvidence, parseSamples, parseStable, stableChanges } from "@brianjenkins94/util/silo/evidence";
import { LOCAL_DIR, SILO_DIR } from "@brianjenkins94/util/silo/layout";
import { annotations } from "./annotations.ts";

/** What every run observed at one span, folded: strict counts summed, faded runs summed, the latest report's time. */
export interface SpanEvidence {
	"reached"?: { "ever": number; "runs": number; "lastAt": string; "coarse"?: true };
	/** `coarse`: some of it is a committed line, so `seen`, `nullish` and each tag's count are each run floor's (how
	 *  many runs at least), not how many values. */
	"value"?: { "seen": number; "nullish": number; "tags": Record<string, number>; "ever": number; "runs": number; "lastAt": string; "coarse"?: true };
	/** `coarse`: some of it is a committed line, so an arm's count says it was taken, not how often. */
	"branch"?: { "arms": number[]; "ever": number; "runs": number; "lastAt": string; "coarse"?: true };
	/** Where a function's time went in the runs that profiled it (a preview's CPU profile): its own (`selfMs`), with what
	 *  it called (`totalMs`), how long those profiles sampled (`profiledMs`), each faded, so its share is `selfMs /
	 *  profiledMs`; and who called it and what it called, by name, each by its ms. */
	"time"?: { "selfMs": number; "totalMs": number; "profiledMs": number; "callers": Record<string, number>; "callees": Record<string, number>; "runs": number; "lastAt": string };
	/** A few of the values themselves, as this machine saw them. */
	"samples"?: (string | number | boolean)[];
}

/** A span with evidence, where it is in the document now: offsets, and its node type when BABLR said. */
export interface Placed { "start": number; "end": number; "type"?: string; "evidence": SpanEvidence }

/** What runs did at a span that they hadn't by the last commit (util's `stableChanges`), where it is in the document. */
export interface PlacedChange { "start": number; "end": number; "type"?: string; "change": StableChange }

export interface EvidenceStore {
	/** The evidence placed in `document` as it is now; undefined when it was edited while being placed, or BABLR can't
	 *  parse it as it is (mid-edit, often) — keep what's drawn: a newer look follows. Empty when there's none, or no
	 *  editor BABLR to place it. */
	"placed": (document: vscodeApi.TextDocument) => Promise<Placed[] | undefined>;
	/** The evidence placed in `text`, a file's as it is on disk (one no editor has open): none when it can't be. */
	"placedIn": (file: string, text: string) => Promise<Placed[]>;
	/** Every file with evidence, workspace-relative. */
	"files": () => Promise<string[]>;
	/** The evidence diff: what runs did in `document` that they hadn't by the last commit — each partition's committed
	 *  lines at HEAD against the working tree's — placed in it as it is now. Undefined as `placed` is; empty outside a
	 *  repository, or with nothing changed. */
	"changes": (document: vscodeApi.TextDocument) => Promise<PlacedChange[] | undefined>;
	/** A file's evidence (or samples) changed: the workspace-relative path. */
	"onDidChange": vscodeApi.Event<string>;
}

/** The later of a known report time (if any) and a new one. */
function latest(known: string | undefined, reported: string): string {
	return known !== undefined && known > reported ? known : reported;
}

function foldReached(known: SpanEvidence, observation: Extract<Observation, { "kind": "reached" }>): SpanEvidence {
	const before = known.reached;

	return { ...known, "reached": { "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
}

function foldValue(known: SpanEvidence, observation: Extract<Observation, { "kind": "value" }>): SpanEvidence {
	const before = known.value;
	const tags = { ...before?.tags };

	for (const [tag, count] of Object.entries(observation.tags)) {
		tags[tag] = (tags[tag] ?? 0) + count;
	}

	return { ...known, "value": { "seen": (before?.seen ?? 0) + observation.seen, "nullish": (before?.nullish ?? 0) + observation.nullish, "tags": tags, "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
}

function foldBranch(known: SpanEvidence, observation: Extract<Observation, { "kind": "branch" }>): SpanEvidence {
	const before = known.branch;
	const arms = Array.from({ "length": Math.max(before?.arms.length ?? 0, observation.arms.length) }, (_, arm) => (before?.arms[arm] ?? 0) + (observation.arms[arm] ?? 0));

	return { ...known, "branch": { "arms": arms, "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
}

/** `a`'s and `b`'s ms by name, summed. */
function addMs(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
	const sum = { ...a };

	for (const [name, ms] of Object.entries(b)) {
		sum[name] = (sum[name] ?? 0) + ms;
	}

	return sum;
}

function foldTime(known: SpanEvidence, observation: Extract<Observation, { "kind": "time" }>): SpanEvidence {
	const before = known.time;

	return { ...known, "time": { "selfMs": (before?.selfMs ?? 0) + observation.w, "totalMs": (before?.totalMs ?? 0) + observation.totalMs, "profiledMs": (before?.profiledMs ?? 0) + observation.profiledMs, "callers": addMs(before?.callers ?? {}, observation.callers), "callees": addMs(before?.callees ?? {}, observation.callees), "runs": (before?.runs ?? 0) + observation.runs, "lastAt": latest(before?.lastAt, observation.lastAt) } };
}

/** A committed line (what was seen, on `runs` runs at least) added to what's known of its span, as coarse evidence. */
function foldStable(known: SpanEvidence, stable: StableObservation): SpanEvidence {
	switch (stable.kind) {
		case "reached": {
			const before = known.reached;

			return { ...known, "reached": { "ever": (before?.ever ?? 0) + (stable.ran ? stable.runs : 0), "runs": (before?.runs ?? 0) + stable.runs, "lastAt": before?.lastAt ?? "", "coarse": true } };
		}

		case "value": {
			const before = known.value;
			const tags = { ...before?.tags };

			for (const tag of stable.tags) {
				tags[tag] = (tags[tag] ?? 0) + stable.runs;
			}

			return { ...known, "value": { "seen": (before?.seen ?? 0) + stable.runs, "nullish": (before?.nullish ?? 0) + (stable.nullish ? stable.runs : 0), "tags": tags, "ever": (before?.ever ?? 0) + stable.runs, "runs": (before?.runs ?? 0) + stable.runs, "lastAt": before?.lastAt ?? "", "coarse": true } };
		}

		case "branch": {
			const before = known.branch;
			const arms = Array.from({ "length": Math.max(before?.arms.length ?? 0, ...stable.taken.map((arm) => arm + 1)) }, (_, arm) => (before?.arms[arm] ?? 0) + (stable.taken.includes(arm) ? 1 : 0));

			return { ...known, "branch": { "arms": arms, "ever": (before?.ever ?? 0) + stable.runs, "runs": (before?.runs ?? 0) + stable.runs, "lastAt": before?.lastAt ?? "", "coarse": true } };
		}

		default:
			return known;
	}
}

/** `observation` added to what's known of its span. */
function fold(known: SpanEvidence, observation: Observation): SpanEvidence {
	switch (observation.kind) {
		case "reached":
			return foldReached(known, observation);

		case "value":
			return foldValue(known, observation);

		case "branch":
			return foldBranch(known, observation);

		case "time":
			return foldTime(known, observation);

		default:
			return known;
	}
}

/** The store, through `vscode` — the extension API of the realm it runs in (an extension's, or core's: the workbench's
 *  own, for the notes margin's coverage) — its watchers and emitter disposed with `subscriptions`. */
export function evidenceStore(vscode: typeof vscodeApi, subscriptions: { "dispose": () => unknown }[]): EvidenceStore {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
	const text = async (uri: vscodeApi.Uri): Promise<string> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "");
	const folders = async (uri: vscodeApi.Uri): Promise<string[]> => Promise.resolve(vscode.workspace.fs.readDirectory(uri)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => []);
	/** Each file's evidence, by workspace-relative path: read when first wanted, again when it changes. */
	const byFile = new Map<string, Promise<Map<string, SpanEvidence>>>();
	/** Each document's placed evidence, for the version it was placed in: the surfaces on one store share one placing. */
	const placings = new Map<string, { "version": number; "placed": Promise<Placed[] | undefined> }>();
	const changed = new vscode.EventEmitter<string>();

	const evidenceOf = (file: string): Promise<Map<string, SpanEvidence>> => {
		let known = byFile.get(file);

		if (known === undefined) {
			known = (async () => {
				const bySpan = new Map<string, SpanEvidence>();
				const evidence = vscode.Uri.joinPath(root, `${SILO_DIR}/evidence`);
				const local = vscode.Uri.joinPath(root, `${LOCAL_DIR}/evidence`);
				/** The partitions this machine has every count of: their committed lines say less of the same runs. */
				const counted = new Set<string>();

				for (const user of await folders(local)) {
					for (const environment of await folders(vscode.Uri.joinPath(local, user))) {
						const observations = parseEvidence(await text(vscode.Uri.joinPath(local, user, environment, `${file}.jsonl`)));

						if (observations.length > 0) {
							counted.add(`${user}/${environment}`);
						}

						for (const observation of observations) {
							bySpan.set(observation.span, fold(bySpan.get(observation.span) ?? {}, observation));
						}
					}
				}

				for (const user of await folders(evidence)) {
					for (const environment of await folders(vscode.Uri.joinPath(evidence, user))) {
						if (counted.has(`${user}/${environment}`)) {
							continue;
						}

						const committed = await text(vscode.Uri.joinPath(evidence, user, environment, `${file}.jsonl`));

						// (an earlier silo committed every count: its lines fold as they did)
						for (const observation of parseEvidence(committed)) {
							bySpan.set(observation.span, fold(bySpan.get(observation.span) ?? {}, observation));
						}

						for (const stable of parseStable(committed)) {
							bySpan.set(stable.span, foldStable(bySpan.get(stable.span) ?? {}, stable));
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

	/** `file`'s evidence placed in `text`: each span found there by its id (lost — or moved to another file — it fades:
	 *  new runs make new evidence). Undefined when `text` can't be parsed as it is: nothing's lost, it can't be told. */
	const placeIn = async (file: string, text: string): Promise<Placed[] | undefined> => {
		const known = await evidenceOf(file);

		if (known.size === 0) {
			return [];
		}

		const spans = [...known.keys()];
		const answer = await annotations(vscode.commands).resolve(text, file, spans.map((span) => observedRef(span, file)), { "observed": true });

		if ("unparsable" in answer) {
			return undefined;
		}

		const found = "value" in answer ? answer.value : [];

		return spans.flatMap((span, index) => {
			const at = found[index]?.candidate;

			return at?.start === undefined || at.end === undefined || at.file !== file ? [] : [{ "start": at.start, "end": at.end, ...at.type === undefined ? {} : { "type": at.type }, "evidence": known.get(span) }];
		});
	};

	/** Where `spans` are in `text` now (`file`'s): each one's place, or undefined where it isn't; undefined in all when
	 *  `text` can't be parsed as it is. */
	const whereIn = async (file: string, text: string, spans: string[]): Promise<({ "start": number; "end": number; "type"?: string } | undefined)[] | undefined> => {
		const answer = await annotations(vscode.commands).resolve(text, file, spans.map((span) => observedRef(span, file)), { "observed": true });

		if ("unparsable" in answer) {
			return undefined;
		}

		const found = "value" in answer ? answer.value : [];

		return spans.map((_, index) => {
			const at = found[index]?.candidate;

			return at?.start === undefined || at.end === undefined || at.file !== file ? undefined : { "start": at.start, "end": at.end, ...at.type === undefined ? {} : { "type": at.type } };
		});
	};

	const changesIn = async (document: vscodeApi.TextDocument): Promise<PlacedChange[] | undefined> => {
		const file = vscode.workspace.asRelativePath(document.uri, false);
		const evidence = vscode.Uri.joinPath(root, `${SILO_DIR}/evidence`);
		const changes: StableChange[] = [];

		for (const user of await folders(evidence)) {
			for (const environment of await folders(vscode.Uri.joinPath(evidence, user))) {
				const path = `${SILO_DIR}/evidence/${user}/${environment}/${file}.jsonl`;
				const working = await text(vscode.Uri.joinPath(evidence, user, environment, `${file}.jsonl`));
				const head = working === "" ? "" : await Promise.resolve(vscode.commands.executeCommand<{ "head"?: string } | undefined>("editor.git.file", path)).then((answer) => answer?.head ?? "", () => "");

				if (head !== "" && head !== working) {
					changes.push(...stableChanges(parseStable(head), parseStable(working)));
				}
			}
		}

		if (changes.length === 0) {
			return [];
		}

		const { version } = document;
		const places = await whereIn(file, document.getText(), changes.map((change) => change.span));

		return places === undefined || document.version !== version ? undefined : changes.flatMap((change, index) => {
			const at = places[index];

			return at === undefined ? [] : [{ ...at, "change": change }];
		});
	};

	const place = async (document: vscodeApi.TextDocument): Promise<Placed[] | undefined> => {
		const { version } = document;
		const placed = await placeIn(vscode.workspace.asRelativePath(document.uri, false), document.getText());

		return document.version === version ? placed : undefined;
	};

	/** The files under one environment's evidence folder: `<file>.jsonl`, at any depth. */
	const evidenceFiles = async (folder: vscodeApi.Uri, prefix = ""): Promise<string[]> => {
		const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).catch(() => [] as [string, vscodeApi.FileType][]);

		return (await Promise.all(entries.map(async ([name, type]) => {
			if (type === vscode.FileType.Directory) {
				return evidenceFiles(vscode.Uri.joinPath(folder, name), `${prefix}${name}/`);
			}

			return name.endsWith(".jsonl") ? [prefix + name.slice(0, -".jsonl".length)] : [];
		}))).flat();
	};

	const watchers = [`**/${SILO_DIR}/evidence/**/*.jsonl`, `**/${LOCAL_DIR}/evidence/**/*.jsonl`, `**/${LOCAL_DIR}/samples/**/*.jsonl`].map((glob) => vscode.workspace.createFileSystemWatcher(glob));
	const onChange = (uri: vscodeApi.Uri): void => {
		// `.silo/[local/]evidence/<user>/<environment>/<file>.jsonl` or `.silo/local/samples/<file>.jsonl` → <file>
		const file = /\/\.silo\/(?:(?:local\/)?evidence\/[^/]+\/[^/]+|local\/samples)\/(.+)\.jsonl$/u.exec(uri.path)?.[1];

		if (file !== undefined) {
			byFile.delete(file);
			placings.clear();
			changed.fire(file);
		}
	};

	subscriptions.push(changed, ...watchers, ...watchers.flatMap((watcher) => [watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange)]));

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
		"placedIn": async (file, text) => await placeIn(file, text) ?? [],
		"changes": changesIn,
		"files": async () => {
			const found = new Set<string>();

			for (const evidence of [vscode.Uri.joinPath(root, `${SILO_DIR}/evidence`), vscode.Uri.joinPath(root, `${LOCAL_DIR}/evidence`)]) {
				for (const user of await folders(evidence)) {
					for (const environment of await folders(vscode.Uri.joinPath(evidence, user))) {
						for (const file of await evidenceFiles(vscode.Uri.joinPath(evidence, user, environment))) {
							found.add(file);
						}
					}
				}
			}

			return [...found].sort();
		},
		"onDidChange": changed.event
	};
}
