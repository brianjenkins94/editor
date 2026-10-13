/**
 * The git service's answers (workbench/git-service.ts, on the hub), as its two faces read them: the shell's review panel
 * and VS Code's Source Control view (the bridge's source-control.ts).
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
