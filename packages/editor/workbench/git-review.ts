/**
 * The review: the working tree as hunks (shared/git-hunks.ts), each with the id a commit or a discard of part of a file
 * names it by (`git.commit` / `git.discard`, git-service.ts) — joined, when asked, with what BABLR says of each change
 * (core's classifier, bablr.ts) and the features whose code each hunk is in (the history extension's
 * `history.features`, which the features map draws). The git service stays git (ARCHITECTURE.md: it doesn't classify);
 * the joining is here, at the edge. Its readers: the shell's review panel (its diff, its cosmetic badges) and agents'
 * `git_review`.
 */
import type { ChangeVerdict, GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { DiffRowInfo, Hunk, Review, ReviewFile } from "../shared/git-hunks";
import type { GitReader } from "./git-service";
import { serve } from "@brianjenkins94/hub";
import { alignedRows, hunksOf } from "../shared/git-hunks";

/** The files BABLR can say something of. */
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** The program by feature, as the features map reads it (`history.features`): each declaration's file, its offsets in
 *  the text now, and which features own it. */
interface Program {
	"features": { "area": string; "name": string }[];
	"code": { "file": string; "start": number; "end": number; "owners": number[] }[];
}

/** What a review is asked for: some files (default, every change), and what to say of each beyond its hunks. */
interface ReviewRequest { "paths"?: string[]; "texts"?: boolean; "verdicts"?: boolean; "owners"?: boolean }

/** Which hunks are cosmetic by BABLR's verdict: a cosmetic file's all are; a semantic file's, those whose working lines
 *  carry no changed node — never a deletion, which leaves no working line to tell by. */
function markCosmetic(hunks: Hunk[], rows: DiffRowInfo[], verdict: ChangeVerdict): void {
	const semantic = new Set(verdict.changedLines);

	for (const hunk of hunks) {
		hunk.cosmetic = verdict.verdict === "cosmetic" || (verdict.verdict === "semantic" && hunk.rows.every((index) => rows[index].rightNo !== undefined && !semantic.has(rows[index].rightNo)));
	}
}

/** Each hunk's owners: the features whose declarations its working lines overlap (a deletion's, the point it was at). */
function markOwners(path: string, working: string, hunks: Hunk[], program: Program): void {
	const code = program.code.filter((each) => each.file === path);
	const starts = [0, ...[...working.matchAll(/\n/gu)].map((match) => match.index + 1)];

	for (const hunk of hunks) {
		const { start, lines } = hunk.working;
		const from = lines === 0 ? starts[start] ?? working.length : starts[start - 1];
		const to = lines === 0 ? from : starts[start - 1 + lines] ?? working.length;
		const owners = new Set(code.filter((each) => each.start <= to && each.end >= from).flatMap((each) => each.owners));

		hunk.owners = [...owners].flatMap((index) => (program.features[index] === undefined ? [] : [program.features[index].area + " / " + program.features[index].name])).toSorted((left, right) => left.localeCompare(right));
	}
}

/** Serve `git.review` on `hub`: the working tree as `git` reads it, BABLR's verdicts by `classify`. */
export function installGitReview(vscode: typeof vscodeApi, hub: Hub, git: GitReader, classify: (before: string, after: string) => Promise<ChangeVerdict>): void {
	const reviewOne = async (change: GitFileChange, request: ReviewRequest, program: Program | undefined): Promise<ReviewFile> => {
		const { head, working } = await git.file(change.path);
		const rows = alignedRows(head, working);
		const hunks = hunksOf(change.path, head, working, rows);
		const verdict = request.verdicts === true && change.status === "M" && CODE.test(change.path) ? await classify(head, working).catch(() => undefined) : undefined;

		if (verdict !== undefined) {
			markCosmetic(hunks, rows, verdict);
		}

		if (program !== undefined) {
			markOwners(change.path, working, hunks, program);
		}

		return { ...change, "hunks": hunks, ...verdict === undefined ? {} : { "verdict": verdict }, ...request.texts === true ? { "head": head, "working": working, "rows": rows } : {} };
	};

	serve(hub, "git.review", async (args): Promise<Review> => {
		const request = (args ?? {}) as ReviewRequest;
		const { files, head } = await git.status();
		const wanted = Array.isArray(request.paths) ? new Set(request.paths) : undefined;
		const program = request.owners === true ? await Promise.resolve(vscode.commands.executeCommand<Program | undefined>("history.features")).catch(() => undefined) : undefined;
		const reviewed: ReviewFile[] = [];

		// One at a time: BABLR's worker is one.
		for (const change of files.filter((each) => wanted?.has(each.path) ?? true)) {
			reviewed.push(await reviewOne(change, request, program));
		}

		return { "files": reviewed, ...head === undefined ? {} : { "head": head } };
	});
}
