/**
 * The review: the working tree as hunks (shared/git-hunks.ts), each with the id a commit or a discard of part of a file
 * names it by (`git.commit`, git-service.ts; `git.discard`, here). The git service stays git (ARCHITECTURE.md); the hunks
 * are here, at the edge. Its readers: the shell's review panel (its diff) and agents' `git_review` / `git_discard`.
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { DiffRowInfo, Review, ReviewFile } from "../shared/git-hunks";
import type { CommitFile } from "./git-engine";
import type { CommitPick, GitReader } from "./git-service";
import { serve } from "@brianjenkins94/hub";
import { alignedRows, committedContent, hunksOf, rowsOfHunks } from "../shared/git-hunks";
import * as engine from "./git-engine";

/** What a review is asked for: some files (default, every change), and whether to send their texts. */
interface ReviewRequest { "paths"?: string[]; "texts"?: boolean }

/** The changed rows of `rows` that aren't in `picked`. */
const unpicked = (rows: DiffRowInfo[], picked: ReadonlySet<number>): Set<number> => new Set(rows.flatMap((row, index) => (row.type !== "ctx" && !picked.has(index) ? [index] : [])));

/** Part of a file as a commit takes it (git-service.ts' `part`): the text HEAD becomes with only the picked hunks or
 *  rows — `whole` when that's all of them, undefined when it's none. */
export async function commitPart(pick: CommitPick, whole: CommitFile, file: GitReader["file"]): Promise<CommitFile | undefined> {
	const { head, working } = await file(pick.path);
	const rows = alignedRows(head, working);
	const left = pick.hunks === undefined ? new Set(pick.except) : unpicked(rows, rowsOfHunks(pick.path, hunksOf(pick.path, head, working, rows), pick.hunks));

	if (left.size === 0) {
		return whole;
	}

	return unpicked(rows, left).size === 0 ? undefined : { "path": pick.path, "content": committedContent(head, working, rows, left) };
}

/** Serve `git.review` and `git.discard` on `hub`: the working tree as `git` reads it. */
export function installGitReview(hub: Hub, git: GitReader): void {
	const reviewOne = async (change: GitFileChange, request: ReviewRequest): Promise<ReviewFile> => {
		const { head, working } = await git.file(change.path);
		const rows = alignedRows(head, working);

		return { ...change, "hunks": hunksOf(change.path, head, working, rows), ...request.texts === true ? { "head": head, "working": working, "rows": rows } : {} };
	};

	serve(hub, "git.review", async (args): Promise<Review> => {
		const request = (args ?? {}) as ReviewRequest;
		const { files, head } = await git.status();
		const wanted = Array.isArray(request.paths) ? new Set(request.paths) : undefined;
		const reviewed: ReviewFile[] = [];

		for (const change of files.filter((each) => wanted?.has(each.path) ?? true)) {
			reviewed.push(await reviewOne(change, request));
		}

		return { "files": reviewed, ...head === undefined ? {} : { "head": head } };
	});

	// Discard a file's working-tree changes: all of them (back to HEAD, or gone), or only the hunks given (`hunks`) or
	// the changed rows given (`rows`, the panel's).
	serve(hub, "git.discard", async (args) => {
		const request = args as { "path"?: string; "hunks"?: string[]; "rows"?: number[] } | null;

		if (typeof request?.path !== "string") {
			throw new TypeError("git.discard needs a path.");
		}

		if (request.hunks === undefined && request.rows === undefined) {
			await engine.discardFile(request.path);
		} else {
			const { head, working } = await git.file(request.path);
			const rows = alignedRows(head, working);
			const reverted = request.hunks === undefined ? new Set(request.rows) : rowsOfHunks(request.path, hunksOf(request.path, head, working, rows), request.hunks);

			await (unpicked(rows, reverted).size === 0 ? engine.discardFile(request.path) : engine.setWorking(request.path, committedContent(head, working, rows, reverted)));
		}

		hub.publish("git.changed");

		return { "ok": true };
	});
}
