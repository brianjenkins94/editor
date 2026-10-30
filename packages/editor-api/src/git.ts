/**
 * The editor's git's answers (workbench/git-service.ts): `editor.git.status`'s files, as the Source Control view reads
 * them (packages/editor/ARCHITECTURE.md, *Extension points* 5), and the hub's `git.*`, as the shell's review panel does — and what BABLR says of a change
 * (`editor.annotations.classify`: the cosmetic extension's badge, the panel's). And where the editor keeps the files it
 * makes for a project (`keptAt`).
 */
import { LOCAL_DIR, SILO_DIR } from "@brianjenkins94/util/silo/layout";

/** The files the editor makes for a project, under `.silo/`: the versions it pins, the dependency baseline, the static
 *  capability surface. */
export const KEPT = ["versions.json", "baseline.json", "capabilities.json"];

/** `.silo/<name>`'s local copy, `.silo/local/<name>`: git doesn't see it (`.silo/.gitignore`). */
export function localOf(shared: string): string {
	return shared.startsWith(`${SILO_DIR}/`) ? `${LOCAL_DIR}/${shared.slice(SILO_DIR.length + 1)}` : shared;
}

/**
 * Where a file the editor makes for a project is read and written (`shared`, `.silo/versions.json` say): there when the
 * repository has it — committed, it's the repository's, shared — and otherwise its local copy, which git doesn't see, so
 * loading a repository doesn't put the editor's files in its next commit (2026-10-30). A repository shares one by
 * committing it at its `.silo/` path. `exists` says whether `shared` is there.
 */
export async function keptAt(shared: string, exists: (path: string) => boolean | Promise<boolean>): Promise<string> {
	return await exists(shared) ? shared : localOf(shared);
}

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
