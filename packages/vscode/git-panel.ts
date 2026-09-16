/**
 * Git review panel — a GitHub-Desktop-style changed-files + diff + commit surface, rendered in the SHELL's RHS
 * chrome (not the vscode SCM viewlet). It's a pure hub consumer: it calls `git.status` / `git.file` / `git.commit`
 * (served by git-service.ts in the workbench realm) over the shell hub, and refreshes on `git.changed`. No monaco,
 * no zen-fs here — this is the "novel review UI over the engine" the git-engine decoupling was for.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";

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
  display: flex; gap: 6px; align-items: baseline; }
.gp .head .count { color: var(--fg); font-weight: 600; }
.gp .files { overflow: auto; flex: 1 1 0; min-height: 80px; }
.gp .file { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: center; padding: 5px 10px;
  cursor: pointer; border-left: 2px solid transparent; }
.gp .file:hover { background: #ffffff10; }
.gp .file[aria-current="true"] { background: #3794ff1f; border-left-color: var(--accent); }
.gp .file .st { font: 600 12px "SF Mono", ui-monospace, monospace; text-align: center; }
.gp .file .st.A { color: #4ec9b0; } .gp .file .st.M { color: #d7ba7d; } .gp .file .st.D { color: #f14c4c; }
.gp .file .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.gp .file .cos { font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.gp .file.cosmetic .nm { opacity: .6; }
.gp .empty { padding: 24px 10px; color: var(--muted); text-align: center; }
/* Plain-diff fallback content, rendered into the shell's overlay body (outside .gp). codehike brings its own CSS. */
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
			<div class="head">Changes <span class="count">0</span></div>
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
	let selected: string | undefined;

	// Hide the diff dialog and drop the file selection (the ✕ button and the "no changes" / "file gone" paths).
	const hideOverlay = (): void => {
		overlay.el.classList.remove("open");
		selected = undefined;

		for (const el of filesEl.querySelectorAll<HTMLElement>(".file")) {
			el.setAttribute("aria-current", "false");
		}
	};

	overlay.close.addEventListener("click", hideOverlay);

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

		// added working-line numbers (for the codehike line marks), derived from the LCS diff
		const addedLines: number[] = [];
		let workingLine = 0;

		for (const row of lineDiff(head, working)) {
			if (row.t === "add") {
				workingLine += 1;
				addedLines.push(workingLine);
			} else if (row.t === "ctx") {
				workingLine += 1;
			}
		}

		// Lazy-load the codehike island (react + codehike + shiki) on first diff; fall back to the plain diff if the
		// module can't load. Once codehike owns overlay.body (a React root), never touch it with innerHTML again.
		try {
			const { mountDiff } = await import("./git-codehike");

			await mountDiff(overlay.body, { "working": working, "addedLines": addedLines, "lang": langFor(path) });
			codehikeActive = true;
		} catch (error) {
			if (!codehikeActive) {
				renderPlain(head, working);
			} else {
				overlay.title.textContent = path + " — diff unavailable";
			}
		}
	};

	const refresh = async (): Promise<void> => {
		const { files } = await rpc.request("git.status") as { "files": GitFileChange[] };

		countEl.textContent = String(files.length);
		commitBtn.disabled = files.length === 0;
		filesEl.innerHTML = "";

		if (files.length === 0) {
			filesEl.innerHTML = `<div class="empty">No changes</div>`;
			hideOverlay();

			return;
		}

		for (const file of files) {
			const row = document.createElement("div");

			row.className = "file" + (file.cosmetic ? " cosmetic" : "");
			row.dataset["path"] = file.path;
			row.setAttribute("aria-current", String(file.path === selected));
			row.innerHTML = `<span class="st ${file.status}">${file.status}</span><span class="nm"></span>${file.cosmetic ? '<span class="cos">cosmetic</span>' : ""}`;
			row.querySelector<HTMLElement>(".nm")!.textContent = file.path;
			row.addEventListener("click", () => { void showDiff(file.path); });
			filesEl.appendChild(row);
		}

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

		commitBtn.disabled = true;

		try {
			await rpc.request("git.commit", { "message": message });
			msgEl.value = "";
		} catch (error) {
			commitBtn.textContent = "Commit failed";
			setTimeout(() => { commitBtn.textContent = "Commit all changes"; }, 1800);
		}

		void refresh();
	});

	hub.subscribe("git.changed", () => { void refresh(); });
	void refresh();
}
