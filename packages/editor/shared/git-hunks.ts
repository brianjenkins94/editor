/**
 * A change as hunks: the line diff of a file's HEAD text against its working text, aligned for the side-by-side review
 * (`rows`), grouped into hunks with ids (`hunksOf`), and a selection of them turned back into the text to commit or to
 * keep (`committedContent`). One implementation for every face that picks part of a change — the shell's review panel
 * by rows, an agent's `git_commit` / `git_discard` by hunk ids — run by the git service (workbench/git-service.ts,
 * `git.review`, `git.commit`, `git.discard`).
 */
import type { ChangeVerdict, GitFileChange } from "@brianjenkins94/editor-api/git";
import type { ArrayChange } from "diff";
import { diffArrays } from "diff";

/** A row of the aligned diff: `ctx` unchanged, `add` / `del` one side only, `mod` a deleted line paired with an added one. */
export interface DiffRowInfo {
	"type": "ctx" | "add" | "del" | "mod";
	/** 1-based HEAD line number, when this row has a left side. */
	"leftNo"?: number;
	/** 1-based working-tree line number, when this row has a right side. */
	"rightNo"?: number;
}

/** A run of changed rows, with nothing unchanged between them. */
export interface Hunk {
	/** From its path and what it removes and adds (and which of the same it is), so it's the same hunk after another of
	 *  the file's is committed or discarded. */
	"id": string;
	/** Indexes into the file's rows. */
	"rows": number[];
	/** The HEAD lines it replaces (the first's 1-based number; for none, the line they'd follow) and the working
	 *  lines it puts there. */
	"head": { "start": number; "lines": number };
	"working": { "start": number; "lines": number };
	"removed": string[];
	"added": string[];
	/** BABLR found nothing in it but formatting and comments (`git.review` with `verdicts`). */
	"cosmetic"?: boolean;
	/** The features whose code it's in, `Area / Name` (`git.review` with `owners`). */
	"owners"?: string[];
}

/** One changed file as `git.review` answers it. */
export interface ReviewFile extends GitFileChange {
	"hunks": Hunk[];
	/** What BABLR says of the whole change (`verdicts`; a modified code file only). */
	"verdict"?: ChangeVerdict;
	/** The texts and the aligned rows the hunks index (`texts`). */
	"head"?: string;
	"working"?: string;
	"rows"?: DiffRowInfo[];
}

export interface Review { "files": ReviewFile[]; "head"?: string }

const linesOf = (text: string): string[] => (text === "" ? [] : text.split("\n"));

/** Past this many changed lines a file's change is one replacement, not a diff (a rewrite, a generated file). */
const MOST_EDITS = 5000;

/** The line diff (jsdiff's Myers diff), as ctx / del / add steps. */
function lineDiff(before: string[], after: string[]): ("ctx" | "del" | "add")[] {
	const changes = diffArrays(before, after, { "maxEditLength": MOST_EDITS }) as ArrayChange<string>[] | undefined;

	if (changes === undefined) {
		return [...before.map(() => "del" as const), ...after.map(() => "add" as const)];
	}

	return changes.flatMap((change) => {
		const step = change.added ? "add" : "ctx";

		return change.value.map(() => (change.removed ? "del" : step));
	});
}

/**
 * The diff of `head` → `working` in the side-by-side form: each run of deletions paired with the additions after it
 * (del[k] ↔ add[k]) into `mod` rows, the leftovers single-sided.
 */
export function alignedRows(head: string, working: string): DiffRowInfo[] {
	const steps = lineDiff(linesOf(head), linesOf(working));
	const rows: DiffRowInfo[] = [];
	let leftNo = 0;
	let rightNo = 0;
	let cursor = 0;

	while (cursor < steps.length) {
		if (steps[cursor] === "ctx") {
			leftNo += 1;
			rightNo += 1;
			rows.push({ "type": "ctx", "leftNo": leftNo, "rightNo": rightNo });
			cursor += 1;
		} else {
			const dels: number[] = [];
			const adds: number[] = [];

			for (; cursor < steps.length && steps[cursor] === "del"; cursor += 1) {
				leftNo += 1;
				dels.push(leftNo);
			}

			for (; cursor < steps.length && steps[cursor] === "add"; cursor += 1) {
				rightNo += 1;
				adds.push(rightNo);
			}

			for (let pair = 0; pair < Math.max(dels.length, adds.length); pair += 1) {
				const [deleted, added] = [dels[pair], adds[pair]];

				if (deleted !== undefined && added !== undefined) {
					rows.push({ "type": "mod", "leftNo": deleted, "rightNo": added });
				} else if (deleted === undefined) {
					rows.push({ "type": "add", "rightNo": added });
				} else {
					rows.push({ "type": "del", "leftNo": deleted });
				}
			}
		}
	}

	return rows;
}

/** FNV-1a, 32 bits, as hex: short ids, no crypto needed (a hunk's id only has to tell a file's hunks apart). */
function fnv(text: string): string {
	let hash = 0x81_1C_9D_C5;

	for (let index = 0; index < text.length; index += 1) {
		hash = Math.imul(hash ^ text.charCodeAt(index), 0x01_00_01_93) >>> 0;
	}

	return hash.toString(16).padStart(8, "0");
}

/** The changed rows of `rows` as hunks, each with its id. */
export function hunksOf(path: string, head: string, working: string, rows: DiffRowInfo[]): Hunk[] {
	const [headLines, workingLines] = [linesOf(head), linesOf(working)];
	const hunks: Hunk[] = [];
	const seen = new Map<string, number>();
	let run: number[] = [];
	// Where the next hunk would start on each side: the line after the last one passed.
	let [leftAt, rightAt] = [1, 1];

	const flush = (): void => {
		if (run.length === 0) {
			return;
		}

		const removed = run.flatMap((index) => (rows[index].leftNo === undefined ? [] : [headLines[rows[index].leftNo - 1]]));
		const added = run.flatMap((index) => (rows[index].rightNo === undefined ? [] : [workingLines[rows[index].rightNo - 1]]));
		const key = fnv(path + "\0" + removed.join("\n") + "\0" + added.join("\n"));
		const repeat = seen.get(key) ?? 0;

		seen.set(key, repeat + 1);
		hunks.push({
			"id": repeat === 0 ? key : key + "-" + repeat,
			"rows": run,
			"head": { "start": removed.length === 0 ? leftAt - 1 : leftAt, "lines": removed.length },
			"working": { "start": added.length === 0 ? rightAt - 1 : rightAt, "lines": added.length },
			"removed": removed,
			"added": added
		});
		leftAt += removed.length;
		rightAt += added.length;
		run = [];
	};

	rows.forEach((row, index) => {
		if (row.type === "ctx") {
			flush();
			leftAt += 1;
			rightAt += 1;
		} else {
			run.push(index);
		}
	});

	flush();

	return hunks;
}

/**
 * The text that HEAD becomes with only some changed rows applied: `left` are the row indexes left as HEAD has them —
 * an added line dropped, a deleted one kept, a modified one as it was. Committing a selection leaves out what wasn't
 * picked; discarding some rows leaves out those.
 */
export function committedContent(head: string, working: string, rows: DiffRowInfo[], left: ReadonlySet<number>): string {
	const [headLines, workingLines] = [linesOf(head), linesOf(working)];

	return rows.flatMap((row, index) => {
		const kept = left.has(index);

		if (row.type === "ctx") {
			return [workingLines[row.rightNo - 1]];
		}

		if (row.type === "add") {
			return kept ? [] : [workingLines[row.rightNo - 1]];
		}

		if (row.type === "del") {
			return kept ? [headLines[row.leftNo - 1]] : [];
		}

		return [kept ? headLines[row.leftNo - 1] : workingLines[row.rightNo - 1]];
	}).join("\n");
}

/** The rows of the hunks named — every id must be one of `hunks`' (else the file changed since it was reviewed). */
export function rowsOfHunks(path: string, hunks: Hunk[], ids: readonly string[]): Set<number> {
	const byId = new Map(hunks.map((hunk) => [hunk.id, hunk]));
	const missing = ids.filter((id) => !byId.has(id));

	if (missing.length > 0) {
		throw new Error(`${path} has no hunk ${missing.join(", ")} now: review it again (its hunks are ${hunks.map((hunk) => hunk.id).join(", ") || "none"})`);
	}

	return new Set(ids.flatMap((id) => byId.get(id)?.rows ?? []));
}

/** A version of a file, for blame: the commit it's at (or "working", for the working tree's) and its text. */
export interface Version { "oid": string; "text": string }

/**
 * Which version each line of the newest one came from (`versions` newest first: the working tree's or HEAD's, then
 * each commit that changed the file, back): a line is the newest version's that it's in when the version after it
 * (older) hasn't it, as a line diff says. A line every version has came from the oldest, or before it (`boundary`:
 * where the versions given end, a shallow clone's first commit, say). Each line's 1-based number in the newest version.
 */
export function blameOf(versions: Version[]): { "line": number; "oid": string; "boundary": boolean }[] {
	if (versions.length === 0) {
		return [];
	}

	const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/u, "").split("\n"));
	const count = lines(versions[0].text).length;
	// (each newest line's index in the version being looked at; undefined once it's placed)
	let at: (number | undefined)[] = Array.from({ "length": count }, (_, index) => index);
	const placed: (string | undefined)[] = Array.from({ "length": count }, () => undefined);

	for (let index = 0; index + 1 < versions.length; index += 1) {
		const newer = lines(versions[index].text);
		const older = lines(versions[index + 1].text);
		// (a newer line's index in the older version, where it's there unchanged)
		const back = new Map<number, number>();
		let [n, o] = [0, 0];

		for (const change of diffArrays(older, newer)) {
			const length = change.count ?? change.value.length;

			if (change.added === true) {
				n += length;
			} else if (change.removed === true) {
				o += length;
			} else {
				for (let step = 0; step < length; step += 1) {
					back.set(n + step, o + step);
				}

				n += length;
				o += length;
			}
		}

		at = at.map((where, line) => {
			if (where === undefined) {
				return undefined;
			}

			if (!back.has(where)) {
				placed[line] = versions[index].oid;

				return undefined;
			}

			return back.get(where);
		});
	}

	const oldest = versions.at(-1)?.oid ?? "";

	return placed.map((oid, line) => ({ "line": line + 1, "oid": oid ?? oldest, "boundary": oid === undefined }));
}
