/**
 * Git review panel — a GitHub-Desktop-style changed-files + diff + commit surface, rendered in the SHELL's RHS
 * chrome (not the vscode SCM viewlet). It's a pure hub consumer: it calls `git.status` / `git.file` / `git.commit`
 * (served by git-service.ts in the workbench realm) over the shell hub, and refreshes on `git.changed`. No monaco,
 * no zen-fs here — this is the "novel review UI over the engine" the git-engine decoupling was for.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import type { ChangeKind } from "./cosmetic-classifier";
import type { DiffRowInfo } from "./git-codehike";

interface GitFileChange { "path": string; "status": "A" | "M" | "D"; "staged": boolean; "unstaged": boolean; "cosmetic": boolean }
interface DiffRow { "t": "ctx" | "add" | "del"; "text": string }

/**
 * The diff dialog — a shell-owned overlay that covers the LHS picker + editor when a file is opened (side-by-side
 * needs the width; the RHS stays the files + commit rail). The shell hands us its four elements; we drive them.
 */
export interface DiffOverlay { "el": HTMLElement; "title": HTMLElement; "body": HTMLElement; "close": HTMLElement }

/** Unified line diff via LCS (fine for the file sizes a review touches). Long unchanged runs are collapsed. */
function lineDiff(before: string, after: string): DiffRow[] {
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ "length": m + 1 }, () => new Array<number>(n + 1).fill(0));

	for (let i = m - 1; i >= 0; i -= 1) {
		for (let j = n - 1; j >= 0; j -= 1) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;

	while (i < m && j < n) {
		if (a[i] === b[j]) {
			rows.push({ "t": "ctx", "text": a[i] });
			i += 1;
			j += 1;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			rows.push({ "t": "del", "text": a[i] });
			i += 1;
		} else {
			rows.push({ "t": "add", "text": b[j] });
			j += 1;
		}
	}

	while (i < m) { rows.push({ "t": "del", "text": a[i] }); i += 1; }
	while (j < n) { rows.push({ "t": "add", "text": b[j] }); j += 1; }

	return rows;
}

/** Collapse runs of >8 unchanged lines to a "⋯ N unchanged" divider (keeping 3 lines of context each side). */
function collapse(rows: DiffRow[]): (DiffRow | { "t": "gap"; "text": string })[] {
	const out: (DiffRow | { "t": "gap"; "text": string })[] = [];
	let run: DiffRow[] = [];

	const flush = (): void => {
		if (run.length > 8) {
			out.push(run[0], run[1], run[2]);
			out.push({ "t": "gap", "text": `⋯ ${run.length - 6} unchanged` });
			out.push(run[run.length - 3], run[run.length - 2], run[run.length - 1]);
		} else {
			out.push(...run);
		}

		run = [];
	};

	for (const row of rows) {
		if (row.t === "ctx") {
			run.push(row);
		} else {
			flush();
			out.push(row);
		}
	}

	flush();

	return out;
}

/**
 * Turn the flat LCS diff into the row-aligned form the side-by-side renderer wants, pairing each run of deletions
 * with the additions that follow it (del[k] ↔ add[k]) into `mod` rows so a replaced line sits opposite its
 * replacement; any leftover on either side stays a single-sided `del` / `add` row.
 */
function buildRows(before: string, after: string): DiffRowInfo[] {
	const diff = lineDiff(before, after);
	const rows: DiffRowInfo[] = [];
	let leftNo = 0;
	let rightNo = 0;
	let k = 0;

	while (k < diff.length) {
		if (diff[k].t === "ctx") {
			leftNo += 1;
			rightNo += 1;
			rows.push({ "type": "ctx", "leftNo": leftNo, "rightNo": rightNo });
			k += 1;

			continue;
		}

		const dels: number[] = [];
		const adds: number[] = [];

		while (k < diff.length && diff[k].t === "del") { leftNo += 1; dels.push(leftNo); k += 1; }
		while (k < diff.length && diff[k].t === "add") { rightNo += 1; adds.push(rightNo); k += 1; }

		for (let p = 0; p < Math.max(dels.length, adds.length); p += 1) {
			const l = dels[p];
			const r = adds[p];

			if (l !== undefined && r !== undefined) {
				rows.push({ "type": "mod", "leftNo": l, "rightNo": r });
			} else if (l !== undefined) {
				rows.push({ "type": "del", "leftNo": l });
			} else {
				rows.push({ "type": "add", "rightNo": r });
			}
		}
	}

	return rows;
}

/**
 * Reconstruct the blob to COMMIT for a partial selection: HEAD with only the SELECTED changes applied. A deselected
 * row index (into `rows`) means "leave this as HEAD" — a deselected add is dropped, a deselected deletion keeps the
 * old line, a deselected modification keeps the old line. Unchanged lines always carry through.
 */
function committedContent(head: string, working: string, rows: DiffRowInfo[], deselected: ReadonlySet<number>): string {
	const headLines = head === "" ? [] : head.split("\n");
	const workingLines = working === "" ? [] : working.split("\n");
	const out: string[] = [];

	rows.forEach((row, index) => {
		const selected = !deselected.has(index);

		if (row.type === "ctx") {
			out.push(workingLines[row.rightNo! - 1]);
		} else if (row.type === "add") {
			if (selected) {
				out.push(workingLines[row.rightNo! - 1]);
			}
		} else if (row.type === "del") {
			if (!selected) {
				out.push(headLines[row.leftNo! - 1]);
			}
		} else {
			out.push(selected ? workingLines[row.rightNo! - 1] : headLines[row.leftNo! - 1]);
		}
	});

	return out.join("\n");
}

const STYLE = `
.gp { display: flex; flex-direction: column; gap: 0; height: 100%; font-size: 13px; }
#git-panel { height: 100%; }
.gp .commit { padding: 10px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px;
  flex: 0 0 auto; background: var(--chrome); }
.gp textarea { width: 100%; min-height: 52px; resize: vertical; background: #ffffff0a; color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; font: inherit; }
.gp textarea:focus { outline: none; border-color: var(--accent); }
.gp .commitBtn { align-self: stretch; border: 0; border-radius: 6px; padding: 8px; cursor: pointer;
  background: var(--accent); color: #fff; font-weight: 600; }
.gp .commitBtn:disabled { opacity: .5; cursor: default; }
.gp .head { padding: 8px 10px; text-transform: uppercase; font-size: 11px; letter-spacing: .06em; color: var(--muted);
  display: flex; gap: 6px; align-items: center; }
.gp .head .count { color: var(--fg); font-weight: 600; }
.gp .pick, .gp .pickAll { margin: 0; cursor: pointer; accent-color: var(--accent); flex: 0 0 auto; }
.gp .files { overflow: auto; flex: 1 1 0; min-height: 80px; }
.gp .file { display: grid; grid-template-columns: 16px 16px 1fr auto; gap: 8px; align-items: center; padding: 5px 10px;
  cursor: pointer; border-left: 2px solid transparent; }
.gp .file:hover { background: #ffffff10; }
.gp .file[aria-current="true"] { background: #3794ff1f; border-left-color: var(--accent); }
.gp .file .st { font: 600 12px "SF Mono", ui-monospace, monospace; text-align: center; }
.gp .file .st.A { color: #4ec9b0; } .gp .file .st.M { color: #d7ba7d; } .gp .file .st.D { color: #f14c4c; }
.gp .file .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.gp .file .tail { display: flex; align-items: center; gap: 6px; }
.gp .file .cos { font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.gp .file .discard { visibility: hidden; border: 0; background: none; color: var(--muted); cursor: pointer;
  font-size: 15px; line-height: 1; padding: 0 2px; }
.gp .file:hover .discard { visibility: visible; }
.gp .file .discard:hover { color: #f14c4c; }
.gp .file .discard.armed { visibility: visible; color: #f14c4c; font-size: 11px; font-weight: 600; }
.gp .file.cosmetic .nm { opacity: .6; }
.gp .empty { padding: 24px 10px; color: var(--muted); text-align: center; }
/* "Your edits" — per-file chunk timeline (Automerge edit-bursts, node-grouped). Hovering a chunk spotlights its range
   in the open diff (setDiffHighlight). Rows live here in the changes list; the diff stays open in the overlay. */
.gp .file .exp { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 2px; font-size: 9px; line-height: 1; }
.gp .file .exp:hover { color: var(--fg); }
.gp .chunks { display: flex; flex-direction: column; gap: 1px; padding: 2px 10px 6px 30px; background: #ffffff06; }
.gp .chunk { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 8px; align-items: baseline;
  padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.gp .chunk:hover { background: var(--sxs-hl, #c8a53340); }
.gp .chunk .ck { font-size: 10px; color: var(--muted); text-transform: lowercase; }
.gp .chunk .cl { font-family: "SF Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gp .chunk .ce { color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.gp .chunk .cr { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
.gp .chunk.info { color: var(--muted); cursor: default; display: block; font-size: 11px; }
.gp .chunk.info:hover { background: none; }
/* BABLR verdict banner — sticky at the top of the diff, colour-coded by whether the change moves the meaning. */
#diff-overlay-body .sxs-wrap { display: flex; flex-direction: column; min-height: 100%; }
#diff-overlay-body .sxs-verdict { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; background: var(--chrome); border-bottom: 1px solid var(--line);
  font: 500 11px -apple-system, "Segoe UI", system-ui, sans-serif; letter-spacing: .02em; }
#diff-overlay-body .sxs-verdict .sxs-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
#diff-overlay-body .sxs-verdict.cosmetic { color: #9aa0a6; }
#diff-overlay-body .sxs-verdict.cosmetic .sxs-dot { background: #9aa0a6; }
#diff-overlay-body .sxs-verdict.semantic { color: #e0a35e; }
#diff-overlay-body .sxs-verdict.semantic .sxs-dot { background: #e0a35e; }
#diff-overlay-body .sxs-verdict.unparsable { color: #e0785e; }
#diff-overlay-body .sxs-verdict.unparsable .sxs-dot { background: #e0785e; }
/* Side-by-side codehike diff: HEAD | working, sharing one grid so a row's height is the taller of its two cells
   (that's what keeps alignment under word wrap). Each line is a subgrid item = number gutter + wrapped code. */
#diff-overlay-body .sxs { display: grid; align-items: stretch; padding-bottom: 8px;
  grid-template-columns: minmax(0, 1fr) 4em 14px 4em minmax(0, 1fr);
  font: 12px/1.6 "SF Mono", ui-monospace, monospace; }
/* Center gutter bar (GitHub-Desktop split view): one per change hunk, spanning its rows, toggles the WHOLE change. */
#diff-overlay-body .sxs-hunk { grid-column: 3; border: 0; padding: 2px 0 0; margin: 0; cursor: pointer;
  display: flex; align-items: flex-start; justify-content: center; font-size: 10px; line-height: 1;
  background: #ffffff08; color: transparent; }
#diff-overlay-body .sxs-hunk:hover { background: #ffffff1a; color: var(--muted); }
#diff-overlay-body .sxs-hunk.all { background: var(--accent); color: #fff; }
#diff-overlay-body .sxs-hunk.partial { background: color-mix(in srgb, var(--accent) 45%, transparent); color: #fff; }
/* Both number gutters hug the centre bar: the left pane packs its [✓ #] to the right, the right pane to the left.
   A SELECTED changed line fills the whole gutter cell with the accent (checkmark + number in white) — consecutive
   selected rows read as one solid column, like GitHub Desktop. */
#diff-overlay-body .sxs-num { display: flex; align-items: flex-start; justify-content: flex-start; gap: 3px;
  padding: 0 6px; color: var(--muted); user-select: none; white-space: nowrap; }
/* Number pinned to the outer-right of the gutter with tabular figures, so it lands in the same place on every row
   regardless of the checkmark or fold chevron beside it. The chevron lives in a fixed-width slot for the same reason. */
#diff-overlay-body .sxs-lineno { margin-left: auto; font-variant-numeric: tabular-nums; }
#diff-overlay-body .sxs-fold-slot { flex: 0 0 auto; width: 11px; display: flex; align-items: flex-start; justify-content: center; }
#diff-overlay-body .sxs-num.sel { background: var(--accent); }
#diff-overlay-body .sxs-num.sel, #diff-overlay-body .sxs-num.sel .sxs-lineno, #diff-overlay-body .sxs-num.sel .sxs-fold { color: #fff; }
#diff-overlay-body .sxs-pick { flex: 0 0 auto; width: 12px; height: 17px; border: 0; padding: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1;
  background: transparent; color: inherit; }
#diff-overlay-body .sxs-line:hover .sxs-num:not(.sel) .sxs-pick { color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); }
/* Dividers flanking the centre bar (inner edge of each pane's number gutter). */
#diff-overlay-body .sxs-line.left .sxs-num, #diff-overlay-body .sxs-empty.left { border-right: 1px solid var(--line); }
#diff-overlay-body .sxs-line.right .sxs-num, #diff-overlay-body .sxs-empty.right { border-left: 1px solid var(--line); }
#diff-overlay-body .sxs-code { padding: 0 10px; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
#diff-overlay-body .sxs-empty { background: #ffffff05; }
/* Per-line focus: once BABLR reports back, a changed line that carries NO semantic (node-level) change fades DOWN,
   so the eye stays on real edits. Transition doubles as the lazy fade-in when the verdict arrives; hover restores. */
#diff-overlay-body .sxs-line { transition: opacity .45s ease; }
#diff-overlay-body .sxs-line.faded { opacity: .38; }
#diff-overlay-body .sxs-line.faded:hover { opacity: 1; }
/* Right-click discard menu. */
#diff-overlay-body .sxs-menu-backdrop { position: fixed; inset: 0; z-index: 50; }
#diff-overlay-body .sxs-menu { position: fixed; min-width: 180px; background: var(--chrome); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px; box-shadow: 0 6px 20px #0009; font: 13px -apple-system, "Segoe UI", system-ui, sans-serif; }
#diff-overlay-body .sxs-menu-item { display: block; width: 100%; text-align: left; border: 0; background: none;
  color: var(--fg); padding: 6px 10px; border-radius: 4px; cursor: pointer; font: inherit; white-space: nowrap; }
#diff-overlay-body .sxs-menu-item:hover { background: #f14c4c; color: #fff; }
/* Block-fold chevron (right gutter) + the "⋯" left on a folded header line. */
#diff-overlay-body .sxs-fold { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0; font-size: 9px; line-height: 1.6; }
#diff-overlay-body .sxs-fold:hover { color: var(--fg); }
#diff-overlay-body .sxs-folded-mark { color: var(--muted); }
/* Collapsed unchanged-context gap — spans both columns, click to reveal. */
#diff-overlay-body .sxs-gap { grid-column: 1 / span 5; text-align: left; border: 0; cursor: pointer; font: inherit;
  background: #ffffff08; color: var(--muted); padding: 2px 12px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
#diff-overlay-body .sxs-gap:hover { background: #ffffff14; color: var(--fg); }
/* Plain-diff fallback content, rendered into the overlay body (outside .gp) when the codehike island can't load. */
#diff-overlay-body .diff { font: 12px/1.5 "SF Mono", ui-monospace, monospace; padding: 4px 0; }
#diff-overlay-body .diff .row { padding: 0 12px; white-space: pre-wrap; }
#diff-overlay-body .diff .add { background: #4ec9b022; color: #cfeee6; }
#diff-overlay-body .diff .del { background: #f14c4c22; color: #f3c9c9; }
#diff-overlay-body .diff .ctx { color: var(--muted); }
#diff-overlay-body .diff .gap { color: var(--muted); text-align: center; background: #ffffff08; font-style: italic; }
`;

/**
 * Mount the review panel into `container` (files list + commit box), driving the shell's diff `overlay` when a file
 * is opened, and talking to the git service over `hub`.
 */
export function renderGitPanel(container: HTMLElement, overlay: DiffOverlay, hub: Hub): void {
	if (!document.getElementById("gp-style")) {
		const style = document.createElement("style");

		style.id = "gp-style";
		style.textContent = STYLE;
		document.head.appendChild(style);
	}

	container.innerHTML = `
		<div class="gp">
			<div class="head"><input type="checkbox" class="pickAll" checked title="Select all changes"> Changes <span class="count">0</span></div>
			<div class="files"></div>
			<div class="commit">
				<textarea class="msg" placeholder="Summary — describe your changes"></textarea>
				<button class="commitBtn" disabled>Commit all changes</button>
			</div>
		</div>`;

	const rpc = createRpcClient(hub);
	const filesEl = container.querySelector<HTMLElement>(".files")!;
	const countEl = container.querySelector<HTMLElement>(".count")!;
	const msgEl = container.querySelector<HTMLTextAreaElement>(".msg")!;
	const commitBtn = container.querySelector<HTMLButtonElement>(".commitBtn")!;
	const pickAll = container.querySelector<HTMLInputElement>(".pickAll")!;
	let selected: string | undefined;
	// Files the reviewer has UN-checked entirely (excluded from the commit). Absence = selected.
	const deselected = new Set<string>();
	// Per-file PARTIAL selection: row indices (into that file's diff rows) the reviewer un-checked in the diff.
	const lineDeselect = new Map<string, Set<number>>();
	// Changed-row count per file that has an open/partial selection, so a file row can show its indeterminate state.
	const changedCount = new Map<string, number>();
	// Files whose "your edits" chunk timeline is expanded in the list (kept across refreshes, like `deselected`).
	const expandedFiles = new Set<string>();
	// The changed files from the latest status, for the master checkbox + commit to consult.
	let currentFiles: GitFileChange[] = [];

	// Hide the diff dialog and drop the file selection (the ✕ button and the "no changes" / "file gone" paths).
	const hideOverlay = (): void => {
		overlay.el.classList.remove("open");
		selected = undefined;

		for (const el of filesEl.querySelectorAll<HTMLElement>(".file")) {
			el.setAttribute("aria-current", "false");
		}
	};

	overlay.close.addEventListener("click", hideOverlay);

	// A file is fully in ("all"), fully out ("off"), or has a per-line partial selection ("partial"). A partial
	// selection that has grown to cover every changed row reads as "off" (nothing left to commit).
	const fileState = (path: string): "all" | "partial" | "off" => {
		if (deselected.has(path)) {
			return "off";
		}

		const dropped = lineDeselect.get(path);
		const total = changedCount.get(path);

		if (dropped !== undefined && dropped.size > 0) {
			return total !== undefined && dropped.size >= total ? "off" : "partial";
		}

		return "all";
	};

	const isIncluded = (path: string): boolean => fileState(path) !== "off";

	// Reflect the selection everywhere: each file checkbox (tri-state), the master checkbox, the commit button.
	const syncSelectionUi = (): void => {
		const total = currentFiles.length;
		const chosen = currentFiles.filter((file) => isIncluded(file.path)).length;
		const anyPartial = currentFiles.some((file) => fileState(file.path) === "partial");

		pickAll.checked = total > 0 && chosen === total && !anyPartial;
		pickAll.indeterminate = chosen > 0 && (chosen < total || anyPartial);
		commitBtn.disabled = chosen === 0;
		commitBtn.textContent = chosen === total && !anyPartial ? "Commit all changes" : "Commit " + chosen + " of " + total;

		for (const row of filesEl.querySelectorAll<HTMLElement>(".file")) {
			const state = fileState(row.dataset["path"]!);
			const checkbox = row.querySelector<HTMLInputElement>(".pick")!;

			checkbox.checked = state !== "off";
			checkbox.indeterminate = state === "partial";
		}
	};

	// Master checkbox: check all → clear every exclusion; uncheck → exclude every file.
	pickAll.addEventListener("change", () => {
		deselected.clear();
		lineDeselect.clear();

		if (!pickAll.checked) {
			for (const file of currentFiles) {
				deselected.add(file.path);
			}
		}

		syncSelectionUi();
	});


	// Plain unified diff (the fallback when the codehike island can't load — e.g. offline: shiki fetches grammars).
	const renderPlain = (head: string, working: string): void => {
		const diff = document.createElement("div");

		diff.className = "diff";

		for (const row of collapse(lineDiff(head, working))) {
			const line = document.createElement("div");

			line.className = "row " + row.t;
			line.textContent = (row.t === "add" ? "+" : row.t === "del" ? "-" : row.t === "gap" ? "" : " ") + row.text;
			diff.appendChild(line);
		}

		overlay.body.replaceChildren(diff);
	};

	const langFor = (path: string): string =>
		/\.(?:tsx|jsx)$/u.test(path) ? "tsx"
			: /\.(?:ts|mts|cts)$/u.test(path) ? "typescript"
				: /\.(?:js|mjs|cjs)$/u.test(path) ? "javascript"
					: /\.json$/u.test(path) ? "json" : "tsx";

	let codehikeActive = false;

	const showDiff = async (path: string): Promise<void> => {
		selected = path;

		for (const el of filesEl.querySelectorAll<HTMLElement>(".file")) {
			el.setAttribute("aria-current", String(el.dataset["path"] === path));
		}

		const { head, working } = await rpc.request("git.file", { "path": path }) as { "head": string; "working": string };

		overlay.title.textContent = path;
		overlay.el.classList.add("open");

		const rows: DiffRowInfo[] = buildRows(head, working);

		changedCount.set(path, rows.filter((row) => row.type !== "ctx").length);

		// Lazy-load the codehike island (react + codehike + shiki) on first diff; fall back to the plain diff if the
		// module can't load. Once codehike owns overlay.body (a React root), never touch it with innerHTML again.
		try {
			const { mountDiff, setDiffHighlight } = await import("./git-codehike");

			setDiffHighlight(null); // drop any spotlight left over from the previously-open file

			await mountDiff(overlay.body, {
				"docKey": path,
				"head": head,
				"working": working,
				"lang": langFor(path),
				"rows": rows,
				"deselectedRows": [...(lineDeselect.get(path) ?? [])],
				"onRowSelection": (dropped) => {
					if (dropped.length === 0) {
						lineDeselect.delete(path);
					} else {
						lineDeselect.set(path, new Set(dropped));
					}

					deselected.delete(path); // touching lines means the file is (partially) IN, not fully excluded
					syncSelectionUi();
				},
				// Lazy BABLR verdict + per-node changed lines (drives the banner and the per-line focus fade) — requested
				// after the diff is on screen. No shell-side cache: identity is the correct key, computed in the worker.
				"classify": async () => {
					const result = await rpc.request("git.classify", { "path": path }) as { "verdict": ChangeKind | "none"; "changedLines"?: number[] };

					return { "verdict": result.verdict, "changedLines": result.changedLines ?? [] };
				},
				// Discard a hunk: recompute the working content with those rows reverted to HEAD, then write it back.
				"onDiscardRows": async (hunkRows) => {
					const fresh = await rpc.request("git.file", { "path": path }) as { "head": string; "working": string };
					const freshRows = buildRows(fresh.head, fresh.working);
					const reverted = committedContent(fresh.head, fresh.working, freshRows, new Set(hunkRows));

					await rpc.request("git.discard", { "path": path, "content": reverted });
				}
			});
			codehikeActive = true;
		} catch (error) {
			if (!codehikeActive) {
				renderPlain(head, working);
			} else {
				overlay.title.textContent = path + " — diff unavailable";
			}
		}
	};

	// A node-grouped chunk of "your edits" (from the Automerge tier), as history.chunks returns it.
	interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

	// Populate a file's expanded chunk list. Each row, on hover, spotlights its line range in the open diff.
	const renderChunks = async (host: HTMLElement, path: string): Promise<void> => {
		host.innerHTML = `<div class="chunk info">Loading your edits…</div>`;

		let setDiffHighlight: (range: { "start": number; "end": number } | null) => void = () => {};

		try {
			({ setDiffHighlight } = await import("./git-codehike"));
		} catch { /* codehike island unavailable — hover highlight is a no-op, the list still renders */ }

		let result: { "groups": EditGroup[]; "bursts": number };

		try {
			result = await rpc.request("history.chunks", { "path": path }) as { "groups": EditGroup[]; "bursts": number };
		} catch {
			host.innerHTML = `<div class="chunk info">Couldn't load edit history.</div>`;

			return;
		}

		if (result.groups.length === 0) {
			host.innerHTML = `<div class="chunk info">No edits recorded since the last commit.</div>`;

			return;
		}

		host.innerHTML = "";

		const header = document.createElement("div");

		header.className = "chunk info";
		header.textContent = result.groups.length + " change" + (result.groups.length === 1 ? "" : "s") + " · " + result.bursts + " edit" + (result.bursts === 1 ? "" : "s");
		host.appendChild(header);

		for (const group of result.groups) {
			const chunk = document.createElement("div");
			const range = group.endLine > group.startLine ? "L" + group.startLine + "–" + group.endLine : "L" + group.startLine;

			chunk.className = "chunk";
			// The "N edits" badge shows only when a region was touched by more than one burst (repeated in-place edits).
			const edits = group.edits > 1 ? `<span class="ce" title="${group.edits} edit-bursts touched this">${group.edits} edits</span>` : `<span class="ce"></span>`;

			chunk.innerHTML = `<span class="ck"></span><span class="cl"></span>${edits}<span class="cr">${range}</span>`;
			chunk.querySelector<HTMLElement>(".ck")!.textContent = group.kind;
			chunk.querySelector<HTMLElement>(".cl")!.textContent = group.label;
			chunk.addEventListener("mouseenter", () => { setDiffHighlight({ "start": group.startLine, "end": group.endLine }); });
			chunk.addEventListener("mouseleave", () => { setDiffHighlight(null); });
			chunk.addEventListener("click", () => { void showDiff(path); });
			host.appendChild(chunk);
		}
	};

	const refresh = async (): Promise<void> => {
		const { files } = await rpc.request("git.status") as { "files": GitFileChange[] };

		currentFiles = files;

		// Drop selection bookkeeping for files that are no longer changed (committed or discarded).
		const stillChanged = (path: string): boolean => files.some((file) => file.path === path);

		for (const path of [...deselected]) {
			if (!stillChanged(path)) {
				deselected.delete(path);
			}
		}

		for (const path of [...lineDeselect.keys()]) {
			if (!stillChanged(path)) {
				lineDeselect.delete(path);
				changedCount.delete(path);
			}
		}

		countEl.textContent = String(files.length);
		filesEl.innerHTML = "";

		if (files.length === 0) {
			filesEl.innerHTML = `<div class="empty">No changes</div>`;
			hideOverlay();
			syncSelectionUi();

			return;
		}

		for (const file of files) {
			const row = document.createElement("div");

			const isCode = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(file.path) && file.status !== "D";
			const expanded = expandedFiles.has(file.path);

			row.className = "file" + (file.cosmetic ? " cosmetic" : "");
			row.dataset["path"] = file.path;
			row.setAttribute("aria-current", String(file.path === selected));
			row.innerHTML = `<input type="checkbox" class="pick"><span class="st ${file.status}">${file.status}</span><span class="nm"></span><span class="tail">${isCode ? `<button class="exp" title="Your edits">${expanded ? "▾" : "▸"}</button>` : ""}${file.cosmetic ? '<span class="cos">cosmetic</span>' : ""}<button class="discard" title="Discard changes">⨯</button></span>`;
			row.querySelector<HTMLElement>(".nm")!.textContent = file.path;

			const checkbox = row.querySelector<HTMLInputElement>(".pick")!;

			checkbox.addEventListener("change", () => {
				// A file-level toggle overrides any per-line selection: fully in, or fully out.
				lineDeselect.delete(file.path);

				if (checkbox.checked) {
					deselected.delete(file.path);
				} else {
					deselected.add(file.path);
				}

				syncSelectionUi();
			});

			// Discard is destructive and can't be undone, so it arms on the first click ("Discard?") and only fires on
			// the second — a lightweight confirm that needs no blocking dialog. It disarms after a few seconds.
			const discardBtn = row.querySelector<HTMLButtonElement>(".discard")!;
			let armed = false;
			let disarmTimer: ReturnType<typeof setTimeout> | undefined;

			discardBtn.addEventListener("click", (event) => {
				event.stopPropagation();

				if (!armed) {
					armed = true;
					discardBtn.classList.add("armed");
					discardBtn.textContent = "Discard?";
					disarmTimer = setTimeout(() => {
						armed = false;
						discardBtn.classList.remove("armed");
						discardBtn.textContent = "⨯";
					}, 3000);

					return;
				}

				clearTimeout(disarmTimer);
				void rpc.request("git.discard", { "path": file.path });
				// git.changed → refresh() repaints the list (and closes the diff if the file is now clean).
			});

			// Open the diff on a row click, EXCEPT clicks on the checkbox, discard, or the "your edits" expander.
			row.addEventListener("click", (event) => {
				if ((event.target as HTMLElement).closest(".pick, .discard, .exp") === null) {
					void showDiff(file.path);
				}
			});

			filesEl.appendChild(row);

			// "Your edits" expander: toggles a node-grouped chunk timeline below the file. Opening it also opens the diff
			// so a chunk-hover has a diff to spotlight into. Expansion survives refresh (re-rendered here from the set).
			const expander = row.querySelector<HTMLButtonElement>(".exp");

			if (expander !== null) {
				const mountChunks = (): HTMLElement => {
					const host = document.createElement("div");

					host.className = "chunks";
					row.after(host);
					void renderChunks(host, file.path);

					return host;
				};

				if (expanded) {
					mountChunks();
				}

				expander.addEventListener("click", (event) => {
					event.stopPropagation();

					const open = row.nextElementSibling?.classList.contains("chunks") === true;

					if (open) {
						expandedFiles.delete(file.path);
						expander.textContent = "▸";
						row.nextElementSibling?.remove();
					} else {
						expandedFiles.add(file.path);
						expander.textContent = "▾";
						void showDiff(file.path); // ensure the diff is open so a chunk-hover has somewhere to spotlight
						mountChunks();
					}
				});
			}
		}

		syncSelectionUi();

		// keep the open diff current, or drop it (and close the dialog) if its file is gone
		if (selected !== undefined && files.some((file) => file.path === selected)) {
			void showDiff(selected);
		} else if (selected !== undefined) {
			hideOverlay();
		}
	};

	commitBtn.addEventListener("click", async () => {
		const message = msgEl.value.trim();

		if (message === "") {
			msgEl.focus();

			return;
		}

		const included = currentFiles.filter((file) => isIncluded(file.path));

		if (included.length === 0) {
			return;
		}

		commitBtn.disabled = true;

		try {
			// Build the commit list: a partial file sends the exact blob to commit (HEAD + selected hunks); a full
			// file just names its path (the service stages the working copy) or flags a deletion.
			const files = await Promise.all(included.map(async (file) => {
				if (fileState(file.path) !== "partial") {
					return { "path": file.path, "deleted": file.status === "D" };
				}

				const { head, working } = await rpc.request("git.file", { "path": file.path }) as { "head": string; "working": string };
				const rows = buildRows(head, working);
				const content = committedContent(head, working, rows, lineDeselect.get(file.path) ?? new Set());

				return { "path": file.path, "content": content };
			}));

			await rpc.request("git.commit", { "message": message, "files": files });
			msgEl.value = "";
			// The committed hunks are gone; any remaining changes should default back to selected next time.
			lineDeselect.clear();
			changedCount.clear();
		} catch (error) {
			commitBtn.textContent = "Commit failed";
			setTimeout(syncSelectionUi, 1800);
		}

		void refresh();
	});

	hub.subscribe("git.changed", () => { void refresh(); });
	void refresh();
}
