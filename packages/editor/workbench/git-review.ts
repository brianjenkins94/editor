/**
 * The review: the working tree as hunks (shared/git-hunks.ts), each with the id a commit or a discard of part of a file
 * names it by (`git.commit` / `git.discard`, git-service.ts). The git service stays git (ARCHITECTURE.md); the hunks are
 * here, at the edge. Its readers: the shell's review panel (its diff) and agents' `git_review`.
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { Review, ReviewFile } from "../shared/git-hunks";
import type { GitReader } from "./git-service";
import { serve } from "@brianjenkins94/hub";
import { alignedRows, hunksOf } from "../shared/git-hunks";

/** What a review is asked for: some files (default, every change), and whether to send their texts. */
interface ReviewRequest { "paths"?: string[]; "texts"?: boolean }

/** Serve `git.review` on `hub`: the working tree as `git` reads it. */
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
}
