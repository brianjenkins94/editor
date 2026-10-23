/**
 * Placed rules (RUNNING.md, *A rule placed in the code*) and the policy files, for the Rules tree, the Rule view, the
 * Margin and agents: where each placed rule's place is now — followed through the edits made to its file since the last
 * commit (the edit history's bursts) by the editor's BABLR (`editor.annotations.*`) — and kept there as its file's
 * saved, a rule's change written, and what a rule gives a program's `process.argv`. The commands, documented in
 * EXTENSION-POINTS 5: `silo.rules.files` (each file's rules and their places), `silo.rules.set(previous, rule)`,
 * `silo.rules.given(program, target)`.
 */
import type { Resolved, SpanRef } from "@brianjenkins94/editor-api/annotations";
import type { Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { loadEffectivePolicy, loadPolicyFiles, movePlace, replaceRule } from "@brianjenkins94/editor-api/policy";
import { given, placesOf } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

/** Where a placed rule's place is now: how it was found (or that it's lost — or `unparsable`, its file can't be parsed as
 *  it is, `why`, so where it is can't be told), its 1-based lines, and — when that isn't its stored place (followed there
 *  through edits, moved, or re-placed by a match) — the reference as it would be made there now. */
export interface PlaceNow { "status": string; "line"?: number; "endLine"?: number; "ref"?: unknown; "why"?: string }

/** How a place found surely enough to act on was found: on its own span, moved, or re-placed by a strong match. */
const SURE = new Set(["attached", "moved", "re-placed"]);

/** A workspace file's text as it is now: its open document's (edits not yet saved included), else what's on disk. */
async function textOf(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

	return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** Resolutions already asked for (resolvePlace), each file's by what they were asked with — so a place followed again
 *  asks BABLR only about what's new: the Rules tree, the margin and keeping places on save each list the rules, and an
 *  edit adds one text to follow through. One asked again while it's being answered is answered once. A resolution also
 *  looks in the other changed files (code moved there), so a file's go when another code file changes. */
const resolved = new Map<string, Map<string, Promise<Resolved | { "unparsable": string } | undefined>>>();
/** Each text asked about, as a short key (the same text, the same key) — dropped with every resolution past this many. */
const textKeys = new Map<string, number>();
const MAX_TEXTS = 1_000;

/** `text`'s key in a resolution's. */
function textKey(text: string): number {
	const known = textKeys.get(text);

	if (known !== undefined) {
		return known;
	}

	textKeys.set(text, textKeys.size);

	return textKeys.size - 1;
}

/** Where `place` is in `text` (of `file`), as BABLR answers (resolvePlace) — rejected when it can't be asked. */
async function askBablr(text: string, file: string, place: unknown, before: string[], byId: boolean): Promise<Resolved | { "unparsable": string } | undefined> {
	const answer = await annotations(vscode.commands).resolve(text, file, [place as SpanRef], byId ? { "observed": true } : { "texts": before });

	if ("unavailable" in answer) {
		throw new Error(answer.unavailable);
	}

	if ("unparsable" in answer) {
		return answer;
	}

	const [found] = answer.value;

	return found?.status === undefined || found.status === "orphaned" || found.candidate?.start === undefined || (found.candidate.file !== undefined && found.candidate.file !== file) ? undefined : found;
}

/** Where `place` is in `text` (of `file`), by the editor's BABLR — if in `file` at all. `before`: texts it may have been
 *  made against, for it to be followed from the one it was by the structural diff. `byId`: by its own span id alone —
 *  whether it's attached, without looking further. `unparsable` (why) when BABLR can't parse `text`: where it is can't
 *  be told, which isn't its being gone. */
async function resolvePlace(text: string, file: string, place: unknown, before: string[] = [], byId = false): Promise<Resolved | { "unparsable": string } | undefined> {
	if (text === "") {
		return undefined; // nothing to find it in (and BABLR reads no empty text)
	}

	if (textKeys.size + before.length >= MAX_TEXTS) {
		textKeys.clear();
		resolved.clear();
	}

	const asked = resolved.get(file) ?? new Map<string, Promise<Resolved | { "unparsable": string } | undefined>>();
	const key = [textKey(text), before.map(textKey).join(","), byId, JSON.stringify(place)].join("|");
	let answered = asked.get(key);

	if (answered === undefined) {
		const asking = askBablr(text, file, place, before, byId);

		answered = asking;
		resolved.set(file, asked);
		asked.set(key, asking);
		asking.catch(() => {
			if (asked.get(key) === asking) {
				asked.delete(key);
			}
		});
	}

	// (one that couldn't be asked — BABLR unavailable — isn't found this time, and is asked again next time)
	return answered.catch(() => undefined);
}

/** A place found, when it was — not one that couldn't be looked for. */
function foundOf(found: Resolved | { "unparsable": string } | undefined): Resolved | undefined {
	return found === undefined || "unparsable" in found ? undefined : found;
}

/** How many of a file's latest edit bursts a placed rule is followed through. */
const HISTORY_STEPS = 30;

/** `place`, followed through `texts` (of `file`, oldest first) one at a time — each step from where it was last surely
 *  found, so an edit and the fix ESLint makes on save are two small steps rather than one jump too big to be sure of —
 *  to where it's surely found in the last (and how), or undefined if it isn't. It's followed from the latest text it's
 *  found in by its own span id (where it was placed, or unchanged since), so no lookalike from before then can take it. */
async function follow(place: unknown, texts: string[], file: string): Promise<{ "at": unknown; "found": Resolved } | undefined> {
	let from = texts.length - 1;

	while (from > 0 && foundOf(await resolvePlace(texts[from], file, place, [], true))?.status !== "attached") {
		from -= 1;
	}

	let at = place;
	let found: Resolved | undefined;

	for (let index = from; index < texts.length; index += 1) {
		// Each step from the texts before it — the reference was made against one of them — by the structural diff. (A
		// text BABLR can't parse — a burst mid-edit — tells nothing: the place goes on from where it was.)
		found = foundOf(await resolvePlace(texts[index], file, at, texts.slice(from, index)));

		if (found !== undefined && SURE.has(found.status) && found.ref !== undefined) {
			at = found.ref;
		}
	}

	return found !== undefined && SURE.has(found.status) ? { "at": at, "found": found } : undefined;
}

/** Where each rule's place is now (RUNNING.md, *A rule placed in the code*) — followed through the edits made to its
 *  file since the last commit (the edit history's bursts, `editor.history.texts`) to its text as it is now (unsaved
 *  edits included), or as saved (`saved`: for a place to be kept); looked for in it directly where it can't be followed
 *  surely (uncertain, or lost). Null for a rule with no place. The margin's marks, the Rules view and keeping places on
 *  save all see a rule where this finds it. */
async function placesNow(rules: Rule[], saved = false): Promise<(PlaceNow | null)[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	/** Each file's texts to follow through, read once for all its rules. */
	const textsOf = new Map<string, Promise<string[]>>();
	const texts = (file: string): Promise<string[]> => {
		const known = textsOf.get(file) ?? (async (): Promise<string[]> => {
			const uri = vscode.Uri.joinPath(root, file);
			const now = saved ? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) : await textOf(uri);
			const history = await Promise.resolve(vscode.commands.executeCommand<string[]>("editor.history.texts", file)).catch(() => []);

			// The latest bursts (a long history needn't be walked from its start), ending at the text now — which the
			// history may not have caught up with yet.
			return [...history.slice(-HISTORY_STEPS), ...history.at(-1) === now ? [] : [now]];
		})();

		textsOf.set(file, known);

		return known;
	};

	return Promise.all(rules.map(async (rule) => {
		const [place] = placesOf(rule) as { "file"?: string }[];

		if (place === undefined || root === undefined || typeof place.file !== "string") {
			return null;
		}

		try {
			const chain = await texts(place.file);
			const text = chain.at(-1);
			const followed = await follow(place, chain, place.file);
			const looked = followed?.found ?? await resolvePlace(text, place.file, place);

			if (looked !== undefined && "unparsable" in looked) {
				return { "status": "unparsable", "why": looked.unparsable };
			}

			const found = foundOf(looked);

			if (found === undefined) {
				return { "status": "orphaned" };
			}

			const lineAt = (offset: number): number => text.slice(0, offset).split("\n").length;
			const { start, end } = found.candidate;
			// The place it's at now, when that isn't the one stored: followed there, or found there by a match.
			let at: unknown = found.ref;

			if (followed !== undefined) {
				at = followed.at === place ? undefined : followed.at;
			}

			return { "status": found.status, "line": lineAt(start), "endLine": lineAt(end ?? start), ...at === undefined ? {} : { "ref": at } };
		} catch {
			return { "status": "orphaned" };
		}
	}));
}

/** `rule` with its place (`at`'s argument) made `place`. */
export function withPlace(rule: Rule, place: unknown): Rule {
	const walk = <P extends Predicate>(predicate: P): P => {
		if ("predicates" in predicate) {
			return { ...predicate, "predicates": predicate.predicates.map(walk) };
		}

		return predicate.target_id === "at" && predicate.operator_id === "is" ? { ...predicate, "argument": place } : predicate;
	};

	return { ...rule, "when": walk(rule.when) };
}

/** Each rule placed in `file` (workspace-relative) — mine and the shared contract's — followed to the file as saved
 *  (placesNow) and, surely found there somewhere other than its stored place (the statement moved, or changed but was
 *  followed or surely matched), kept at that place: its reference made again there, so it's found by its id from then
 *  on, rather than re-placed by hand (RUNNING.md, *A placed rule keeps its place on its own*). A shared rule's new
 *  place is a change to the contract, committed with the code change that moved its code. */
async function keepPlaces(file: string): Promise<void> {
	const files = await loadPolicyFiles();
	const placed = (["mine", "shared"] as const).flatMap((whose) => (files?.[whose].rules ?? []).filter((rule) => (placesOf(rule) as { "file"?: string }[]).some((place) => place?.file === file)).map((rule) => ({ "whose": whose, "rule": rule })));

	if (placed.length === 0) {
		return;
	}

	const places = await placesNow(placed.map(({ rule }) => rule), true);

	for (const [index, { whose, rule }] of placed.entries()) {
		const place = places[index];

		if (place?.ref !== undefined && SURE.has(place.status)) {
			await movePlace(whose, rule, withPlace(rule, place.ref));
		}
	}
}

/** Each policy file's rules — mine, then the shared contract's — and where each placed rule's place is now (null: none),
 *  or null without a folder. */
export async function rulesFiles(): Promise<{ "mine": { "file": string; "rules": Rule[]; "places": (PlaceNow | null)[] }; "shared": { "file": string; "rules": Rule[]; "places": (PlaceNow | null)[] } } | null> {
	const files = await loadPolicyFiles();

	if (files === undefined) {
		return null;
	}

	return { "mine": { ...files.mine, "places": await placesNow(files.mine.rules) }, "shared": { ...files.shared, "places": await placesNow(files.shared.rules) } };
}

/** My policy changed: `previous` (a rule edited, if it's mine) replaced by `rule`, or `rule` added first, or `previous`
 *  removed. Answered with the rule as kept. */
export async function setRule(previous: Rule | undefined, rule: Rule | undefined): Promise<Rule | null> {
	await replaceRule(previous, rule);

	return rule ?? null;
}

/** What a rule gives `program`'s `target` (`process.argv`): matched here, where the policy is. */
export async function givenFor(program: string, target = "process.argv"): Promise<ReturnType<typeof given> | null> {
	const relative = program.startsWith("/") ? vscode.workspace.asRelativePath(vscode.Uri.file(program), false) : program;

	return given(await loadEffectivePolicy(), { "program": relative }, target) ?? null;
}

export function registerRules(context: vscode.ExtensionContext): void {
	// A code file changed: every other file's resolutions may have looked in it.
	const code = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,mjs,cjs}");
	const codeChanged = (uri: vscode.Uri): void => {
		const file = vscode.workspace.asRelativePath(uri, false);

		for (const other of resolved.keys()) {
			if (other !== file) {
				resolved.delete(other);
			}
		}
	};

	context.subscriptions.push(
		code,
		code.onDidChange(codeChanged),
		code.onDidCreate(codeChanged),
		code.onDidDelete(codeChanged),
		// A file saved: the rules placed in it keep the places they're found at.
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.scheme === "file") {
				void keepPlaces(vscode.workspace.asRelativePath(document.uri, false)).catch(() => undefined);
			}
		}),
		vscode.commands.registerCommand("silo.rules.files", rulesFiles),
		vscode.commands.registerCommand("silo.rules.set", async (previous: Rule | undefined, rule: Rule | undefined) => setRule(previous ?? undefined, rule ?? undefined)),
		vscode.commands.registerCommand("silo.rules.given", async (program: unknown, target: unknown) => (typeof program === "string" ? givenFor(program, typeof target === "string" ? target : undefined) : null))
	);
}
