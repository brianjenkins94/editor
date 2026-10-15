/**
 * The editor's git's answers (workbench/git-service.ts): `editor.git.status`'s files, as the Source Control view reads
 * them (EXTENSION-POINTS 5), and the hub's `git.*`, as the shell's review panel does — and what BABLR says of a change
 * (`editor.annotations.classify`: the cosmetic extension's badge, the panel's).
 */

/** BABLR's verdict for a change (mirrors `@brianjenkins94/bablr`). */
export type ChangeKind = "cosmetic" | "semantic" | "unparsable";

/** What BABLR says of a change from one text to another: cosmetic (whitespace, comments) or semantic — "none" for no
 *  verdict — the nodes that changed, and the lines of the second text they're on. */
export interface ChangeVerdict { "verdict": ChangeKind | "none"; "changedNodeIds": string[]; "changedLines": number[] }

/** One changed file as the review panel sees it. */
export interface GitFileChange {
	"path": string;
	"status": "A" | "M" | "D";
	"staged": boolean;
	"unstaged": boolean;
}
