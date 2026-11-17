/**
 * Which changed files are cosmetic: each modified code file's verdict, BABLR's, of HEAD against the working tree; and which
 * files' marks a new reading changes. What's asked (the editor's git, its BABLR) is given, so the extension (extension.ts)
 * asks the editor and its tests answer for it.
 */
import type { ChangeVerdict, GitFileChange } from "@brianjenkins94/editor-api/git";

/** The files BABLR reads: code. */
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

export type Verdict = ChangeVerdict["verdict"] | "none";

/** What a reading asks: the changed files, a file's two texts, and BABLR's verdict on them (undefined: no answer). */
export interface Asks {
	"status": () => Promise<{ "files": GitFileChange[] } | undefined>;
	"file": (path: string) => Promise<{ "head": string; "working": string } | undefined>;
	"classify": (head: string, working: string) => Promise<ChangeVerdict["verdict"] | undefined>;
}

/** Each modified code file's verdict, by its path ("none" for one with no answer); undefined when there's no status. */
export async function verdictsOf(ask: Asks): Promise<Map<string, Verdict> | undefined> {
	const status = await ask.status().catch(() => undefined);

	if (status === undefined) {
		return undefined;
	}

	const verdicts = new Map<string, Verdict>();

	// One at a time: BABLR's worker queues them anyway, and a verdict over texts it has parsed is quick.
	for (const file of status.files.filter((each) => each.status === "M" && CODE.test(each.path))) {
		const texts = await ask.file(file.path).catch(() => undefined);
		const verdict = texts === undefined
			? undefined
			: await ask.classify(texts.head, texts.working).catch(() => undefined);

		verdicts.set(file.path, verdict ?? "none");
	}

	return verdicts;
}

/** The paths whose verdict differs between two readings: the marks to draw again. */
export function changedBetween(before: ReadonlyMap<string, Verdict>, after: ReadonlyMap<string, Verdict>): string[] {
	return [
		...new Set([
			...before.keys(),
			...after.keys()
		])
	].filter((path) => before.get(path) !== after.get(path));
}
