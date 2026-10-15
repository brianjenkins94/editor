/**
 * The editor's git's answers (workbench/git-service.ts): `editor.git.status`'s files, as the Source Control view reads
 * them (EXTENSION-POINTS 5), and the hub's `git.*`, as the shell's review panel does.
 */

/** BABLR's verdict for a change (mirrors `@brianjenkins94/bablr`). */
export type ChangeKind = "cosmetic" | "semantic" | "unparsable";

/** One changed file as the review panel sees it. */
export interface GitFileChange {
	"path": string;
	"status": "A" | "M" | "D";
	"staged": boolean;
	"unstaged": boolean;
	/** True when a MODIFIED file's change is whitespace/comments only (BABLR verdict); false/undefined otherwise. */
	"cosmetic": boolean;
}
