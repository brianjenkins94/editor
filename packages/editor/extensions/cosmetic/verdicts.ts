import type { ChangeVerdict, GitFileChange } from "@brianjenkins94/editor-api/git";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

export type Verdict = ChangeVerdict["verdict"] | "none";

export interface Asks {
	"status": () => Promise<{ "files": GitFileChange[] } | undefined>;
	"file": (path: string) => Promise<{ "head": string; "working": string } | undefined>;
	"classify": (head: string, working: string) => Promise<ChangeVerdict["verdict"] | undefined>;
}

export async function verdictsOf(ask: Asks): Promise<Map<string, Verdict> | undefined> {
	const status = await ask.status().catch(() => undefined);

	if (status === undefined) {
		return undefined;
	}

	const verdicts = new Map<string, Verdict>();

	for (const file of status.files.filter((each) => each.status === "M" && CODE.test(each.path))) {
		const texts = await ask.file(file.path).catch(() => undefined);
		const verdict = texts === undefined
			? undefined
			: await ask.classify(texts.head, texts.working).catch(() => undefined);

		verdicts.set(file.path, verdict ?? "none");
	}

	return verdicts;
}

export function changedBetween(before: ReadonlyMap<string, Verdict>, after: ReadonlyMap<string, Verdict>): string[] {
	return [
		...new Set([
			...before.keys(),
			...after.keys()
		])
	].filter((path) => before.get(path) !== after.get(path));
}
