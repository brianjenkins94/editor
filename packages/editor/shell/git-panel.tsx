/** @jsxImportSource preact */
/**
 * Git review panel — a GitHub-Desktop-style changed-files + diff + commit surface, rendered in the SHELL's RHS chrome
 * (not the vscode SCM viewlet). Built on Web Awesome components (wa-checkbox / wa-textarea / wa-button / wa-badge) and
 * utility classes in a preact tree; what's left in theme/exceptions/git-panel.css is the rows' hover/current states and
 * the side-by-side diff renderer's grid. It's a pure hub consumer: it calls
 * `git.status` / `git.file` / `git.commit` (served by git-service.ts in the workbench realm) over the shell hub, and
 * refreshes on `git.changed`. No monaco, no zen-fs here — the "novel review UI over the engine" the git-engine
 * decoupling was for. The diff opens in a shell-owned overlay the codehike island mounts into (overlay.body).
 */
import type { ChangeVerdict, GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { ComponentChildren } from "preact";
import type { DiffRowInfo } from "./git-codehike";
import { createRpcClient } from "@brianjenkins94/hub";
import { Fragment, render } from "preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { caption } from "theme/recipes";
import "theme/components/checkbox";
import "theme/components/textarea";
import "theme/components/button";
import "theme/components/badge";
// The theme (Web Awesome's layer order among it) first, so git-panel.css's `@layer app` is declared after it (the shell
// imports this module before it imports the theme itself).
import "theme/chrome";
import "theme/exceptions/git-panel.css";

interface DiffRow { "t": "ctx" | "add" | "del"; "text": string }

/**
 * The diff dialog — a shell-owned overlay that covers the editor when a file is opened. The shell hands us its four
 * elements; we drive them imperatively (codehike mounts a React root into `body`, so it stays outside preact).
 */
export interface DiffOverlay { "el": HTMLElement; "title": HTMLElement; "body": HTMLElement; "close": HTMLElement }

/** A node-grouped chunk of "your edits" (from the Automerge tier), as history.chunks returns it. */
interface EditGroup { "label": string; "kind": string; "startLine": number; "endLine": number; "edits": number; "nodeIds": string[] }

/** Unified line diff via LCS (fine for the file sizes a review touches). */
function lineDiff(before: string, after: string): DiffRow[] {
	const left = before === "" ? [] : before.split("\n");
	const right = after === "" ? [] : after.split("\n");
	const leftCount = left.length;
	const rightCount = right.length;
	const dp: number[][] = Array.from({ "length": leftCount + 1 }, () => Array.from({ "length": rightCount + 1 }, () => 0));

	for (let leftIndex = leftCount - 1; leftIndex >= 0; leftIndex -= 1) {
		for (let rightIndex = rightCount - 1; rightIndex >= 0; rightIndex -= 1) {
			dp[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex] ? dp[leftIndex + 1][rightIndex + 1] + 1 : Math.max(dp[leftIndex + 1][rightIndex], dp[leftIndex][rightIndex + 1]);
		}
	}

	const rows: DiffRow[] = [];
	let leftIndex = 0;
	let rightIndex = 0;

	while (leftIndex < leftCount && rightIndex < rightCount) {
		if (left[leftIndex] === right[rightIndex]) {
			rows.push({ "t": "ctx", "text": left[leftIndex] });
			leftIndex += 1;
			rightIndex += 1;
		} else if (dp[leftIndex + 1][rightIndex] >= dp[leftIndex][rightIndex + 1]) {
			rows.push({ "t": "del", "text": left[leftIndex] });
			leftIndex += 1;
		} else {
			rows.push({ "t": "add", "text": right[rightIndex] });
			rightIndex += 1;
		}
	}

	while (leftIndex < leftCount) {
		rows.push({ "t": "del", "text": left[leftIndex] });
		leftIndex += 1;
	}

	while (rightIndex < rightCount) {
		rows.push({ "t": "add", "text": right[rightIndex] });
		rightIndex += 1;
	}

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
 * Turn the flat LCS diff into the row-aligned form the side-by-side renderer wants, pairing each run of deletions with
 * the additions that follow it (del[k] ↔ add[k]) into `mod` rows; leftovers stay single-sided `del` / `add`.
 */
function buildRows(before: string, after: string): DiffRowInfo[] {
	const diff = lineDiff(before, after);
	const rows: DiffRowInfo[] = [];
	let leftNo = 0;
	let rightNo = 0;
	let cursor = 0;

	while (cursor < diff.length) {
		if (diff[cursor].t === "ctx") {
			leftNo += 1;
			rightNo += 1;
			rows.push({ "type": "ctx", "leftNo": leftNo, "rightNo": rightNo });
			cursor += 1;
		} else {
			const dels: number[] = [];
			const adds: number[] = [];

			while (cursor < diff.length && diff[cursor].t === "del") {
				leftNo += 1;
				dels.push(leftNo);
				cursor += 1;
			}

			while (cursor < diff.length && diff[cursor].t === "add") {
				rightNo += 1;
				adds.push(rightNo);
				cursor += 1;
			}

			for (let pair = 0; pair < Math.max(dels.length, adds.length); pair += 1) {
				const deleted = dels[pair];
				const added = adds[pair];

				if (deleted !== undefined && added !== undefined) {
					rows.push({ "type": "mod", "leftNo": deleted, "rightNo": added });
				} else if (deleted !== undefined) {
					rows.push({ "type": "del", "leftNo": deleted });
				} else {
					rows.push({ "type": "add", "rightNo": added });
				}
			}
		}
	}

	return rows;
}

/**
 * Reconstruct the blob to COMMIT for a partial selection: HEAD with only the SELECTED changes applied. A deselected
 * row index means "leave this as HEAD" — a deselected add is dropped, a deselected deletion keeps the old line, a
 * deselected modification keeps the old line. Unchanged lines always carry through.
 */
function committedContent(head: string, working: string, rows: DiffRowInfo[], deselected: ReadonlySet<number>): string {
	const headLines = head === "" ? [] : head.split("\n");
	const workingLines = working === "" ? [] : working.split("\n");
	const out: string[] = [];

	rows.forEach((row, index) => {
		const selected = !deselected.has(index);

		if (row.type === "ctx") {
			out.push(workingLines[row.rightNo - 1]);
		} else if (row.type === "add") {
			if (selected) {
				out.push(workingLines[row.rightNo - 1]);
			}
		} else if (row.type === "del") {
			if (!selected) {
				out.push(headLines[row.leftNo - 1]);
			}
		} else {
			out.push(selected ? workingLines[row.rightNo - 1] : headLines[row.leftNo - 1]);
		}
	});

	return out.join("\n");
}

function langFor(path: string): string {
	if (/\.(?:tsx|jsx)$/u.test(path)) {
		return "tsx";
	}

	if (/\.(?:ts|mts|cts)$/u.test(path)) {
		return "typescript";
	}

	if (/\.(?:js|mjs|cjs)$/u.test(path)) {
		return "javascript";
	}

	return path.endsWith(".json") ? "json" : "tsx";
}

/** How a row of the plain diff is marked, by its kind. */
const ROW_MARKS: Record<DiffRow["t"] | "gap", string> = { "add": "+", "del": "-", "gap": "", "ctx": " " };

/** The commit button's label: a failure, everything, or how much of it. */
function commitLabelOf(commitError: boolean, allChecked: boolean, chosen: number, total: number): string {
	if (commitError) {
		return "Commit failed";
	}

	return allChecked ? "Commit all changes" : "Commit " + chosen + " of " + total;
}

const isCodeFile = (file: GitFileChange): boolean => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(file.path) && file.status !== "D";

/** Current OS colour scheme — the diff highlights with the matching shiki theme (the shell drives the same query). */
const prefersDark = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** A chunk timeline's note line (a status, or the summary above the chunks). */
const CHUNK_INFO = "gp-chunk-info wa-font-size-2xs wa-color-text-quiet";

/** What the chunk timeline says until it has chunks to show. */
const CHUNK_NOTES = { "loading": "Loading your edits…", "error": "Couldn't load edit history.", "empty": "No edits recorded since the last commit." };

/** A file's status letter, by the Web Awesome variant it's drawn in: added, modified, deleted. */
const STATUS_VARIANTS: Record<GitFileChange["status"], string> = { "A": "success", "M": "warning", "D": "danger" };

/** The "your edits" chunk timeline for one expanded file — hovering a chunk spotlights its range in the open diff. */
function Chunks({ path, rpc, onOpen }: { "path": string; "rpc": ReturnType<typeof createRpcClient>; "onOpen": (path: string) => void }) {
	const [state, setState] = useState<{ "status": "loading" | "error" | "empty" | "ready"; "groups"?: EditGroup[]; "bursts"?: number }>({ "status": "loading" });
	const highlightRef = useRef<(range: { "start": number; "end": number } | null) => void>(() => { /* set once codehike loads */ });

	useEffect(() => {
		let live = true;

		void import("./git-codehike").then(({ setDiffHighlight }) => {
			highlightRef.current = setDiffHighlight;
		}).catch(() => { /* island unavailable — hover is a no-op */ });

		void (async () => {
			try {
				const result = await rpc.request("history.chunks", { "path": path }) as { "groups": EditGroup[]; "bursts": number };

				if (!live) {
					return;
				}

				setState(result.groups.length === 0 ? { "status": "empty" } : { "status": "ready", "groups": result.groups, "bursts": result.bursts });
			} catch {
				if (live) {
					setState({ "status": "error" });
				}
			}
		})();

		return () => {
			live = false;
		};
	}, [path, rpc]);

	if (state.status !== "ready") {
		return <div class="gp-chunks wa-stack wa-gap-0"><div class={CHUNK_INFO}>{CHUNK_NOTES[state.status]}</div></div>;
	}

	const groups = state.groups ?? [];

	return (
		<div class="gp-chunks wa-stack wa-gap-0">
			<div class={CHUNK_INFO}>{groups.length + " change" + (groups.length === 1 ? "" : "s") + " · " + (state.bursts ?? 0) + " edit" + (state.bursts === 1 ? "" : "s")}</div>

			{groups.map((group, index) => {
				const range = group.endLine > group.startLine ? "L" + group.startLine + "–" + group.endLine : "L" + group.startLine;

				return (
					<div
						key={index}
						class="gp-chunk wa-cluster wa-flex-nowrap wa-gap-xs wa-align-items-baseline wa-border-radius-s wa-font-size-xs"
						onMouseEnter={() => { highlightRef.current({ "start": group.startLine, "end": group.endLine }); }}
						onMouseLeave={() => { highlightRef.current(null); }}
						onClick={() => { onOpen(path); }}
					>
						<span class="wa-font-size-3xs wa-text-lowercase wa-color-text-quiet">{group.kind}</span>

						<span class="gp-chunk-label wa-text-truncate">{group.label}</span>

						{group.edits > 1 && (
							<wa-badge variant="neutral" appearance="outlined" title={group.edits + " edit-bursts touched this"}>
								{group.edits}

								{" "}
								edits
							</wa-badge>
						)}

						<span class="wa-font-size-2xs wa-color-text-quiet">{range}</span>
					</div>
				);
			})}
		</div>
	);
}

/** One changed-file row: tri-state pick, status, name, and a tail (your-edits expander, cosmetic badge, discard). */
function FileRow({ file, cosmetic, state, current, expanded, onPick, onOpen, onToggleExpand, onDiscard }: {
	"file": GitFileChange;
	/** Its change is formatting or comments only (BABLR's verdict). */
	"cosmetic": boolean;
	"state": "all" | "partial" | "off";
	"current": boolean;
	"expanded": boolean;
	"onPick": (checked: boolean) => void;
	"onOpen": () => void;
	"onToggleExpand": () => void;
	"onDiscard": () => void;
}) {
	const [armed, setArmed] = useState(false);
	const disarmRef = useRef<ReturnType<typeof setTimeout>>();

	// Discard is destructive + can't be undone, so it arms on the first click ("Discard?") and fires on the second — a
	// lightweight confirm with no blocking dialog. It disarms after a few seconds.
	const clickDiscard = (event: MouseEvent): void => {
		event.stopPropagation();

		if (!armed) {
			setArmed(true);
			disarmRef.current = setTimeout(() => {
				setArmed(false);
			}, 3000);

			return;
		}

		clearTimeout(disarmRef.current);
		setArmed(false);
		onDiscard();
	};

	const clickRow = (event: MouseEvent): void => {
		if ((event.target as HTMLElement).closest("wa-checkbox, .gp-discard, .gp-expand") === null) {
			onOpen();
		}
	};

	const clickExpand = (event: MouseEvent): void => {
		event.stopPropagation();
		onToggleExpand();
	};

	return (
		<div class="gp-file wa-cluster wa-flex-nowrap wa-gap-xs" aria-current={current} onClick={clickRow}>
			<wa-checkbox checked={state !== "off"} indeterminate={state === "partial"} onChange={(event: Event) => { onPick((event.target as HTMLInputElement).checked); }} />

			<wa-badge class="gp-status" variant={STATUS_VARIANTS[file.status]} appearance="filled">{file.status}</wa-badge>

			<span class={"gp-name wa-text-truncate" + (cosmetic ? " wa-color-text-quiet" : "")}><bdi dir="ltr">{file.path}</bdi></span>

			<span class="wa-cluster wa-flex-nowrap wa-gap-2xs">
				{isCodeFile(file) && <wa-button class="gp-expand" appearance="plain" size="small" title="Your edits" aria-label="Your edits" onClick={clickExpand}>{expanded ? "▾" : "▸"}</wa-button>}

				{cosmetic && <wa-badge variant="neutral">cosmetic</wa-badge>}

				<wa-button class={"gp-discard" + (armed ? " armed" : "")} appearance="plain" size="small" variant="danger" title="Discard changes" aria-label="Discard changes" onClick={clickDiscard}>{armed ? "Discard?" : "⨯"}</wa-button>
			</span>
		</div>
	);
}

/** The review panel: files list + commit box, driving the shell's diff overlay. */
function GitPanel({ overlay, hub, headerEnd }: { "overlay": DiffOverlay; "hub": Hub; "headerEnd"?: ComponentChildren }) {
	const rpcRef = useRef<ReturnType<typeof createRpcClient>>();

	rpcRef.current ??= createRpcClient(hub);
	const rpc = rpcRef.current;

	const [files, setFiles] = useState<GitFileChange[]>([]);
	/** The changed files whose change is cosmetic, by path (BABLR's verdict, asked as they're listed). */
	const [cosmetic, setCosmetic] = useState<ReadonlySet<string>>(new Set());
	const [selected, setSelected] = useState<string | undefined>(undefined);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState(false);
	const [, force] = useReducer((x: number) => x + 1, 0);

	// Files fully UN-checked (excluded from the commit). Absence = selected. Per-file PARTIAL line selections + the
	// changed-row count per file live alongside. Mutable refs (mirroring the original imperative model) + force().
	const deselected = useRef(new Set<string>()).current;
	const lineDeselect = useRef(new Map<string, Set<number>>()).current;
	const changedCount = useRef(new Map<string, number>()).current;
	const codehikeActive = useRef(false);
	const msgRef = useRef<HTMLElement>(null); // wa-textarea; exposes a `value` property at runtime

	// A file is fully in ("all"), fully out ("off"), or has a per-line partial selection ("partial"). A partial
	// selection covering every changed row reads as "off".
	const fileState = (path: string): FileState["state"] => {
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

	const hideOverlay = (): void => {
		overlay.el.classList.remove("open");
		setSelected(undefined);
	};

	// Plain unified diff (fallback when the codehike island can't load — e.g. offline: shiki fetches grammars).
	const renderPlain = (head: string, working: string): void => {
		const diff = document.createElement("div");

		diff.className = "sxs-plain";

		for (const row of collapse(lineDiff(head, working))) {
			const line = document.createElement("div");

			line.className = "sxs-plain-row " + row.t;
			line.textContent = ROW_MARKS[row.t] + row.text;
			diff.appendChild(line);
		}

		overlay.body.replaceChildren(diff);
	};

	/** What BABLR says of a change from `before` to `after` (the workbench's classifier: `annotations.classify`). */
	const classify = async (before: string, after: string): Promise<ChangeVerdict | undefined> => {
		if (before === "" || after === "") {
			return undefined;
		}

		const answer = await rpc.request("annotations.classify", { "before": before, "after": after }, { "timeoutMs": 120_000 }).catch(() => undefined) as { "value"?: ChangeVerdict } | undefined;

		return answer?.value;
	};

	/** Each modified code file's verdict, asked one at a time (BABLR's worker is one): the cosmetic ones badged. */
	const classifyAll = async (changed: GitFileChange[]): Promise<void> => {
		const found = new Set<string>();

		for (const file of changed.filter((each) => each.status === "M" && isCodeFile(each))) {
			const texts = await rpc.request("git.file", { "path": file.path }).catch(() => undefined) as { "head": string; "working": string } | undefined;

			if (texts !== undefined && (await classify(texts.head, texts.working))?.verdict === "cosmetic") {
				found.add(file.path);
			}
		}

		setCosmetic(found);
	};

	const showDiff = async (path: string): Promise<void> => {
		setSelected(path);

		const { head, working } = await rpc.request("git.file", { "path": path }) as { "head": string; "working": string };

		overlay.title.textContent = path;
		overlay.el.classList.add("open");

		const rows = buildRows(head, working);

		changedCount.set(path, rows.filter((row) => row.type !== "ctx").length);

		// Lazy-load the codehike island (react + codehike + shiki) on first diff; fall back to the plain diff if it
		// can't load. Once codehike owns overlay.body (a React root), never touch it with innerHTML again.
		try {
			const { mountDiff, setDiffHighlight } = await import("./git-codehike");

			setDiffHighlight(null); // drop any spotlight left over from the previously-open file

			await mountDiff(overlay.body, {
				"docKey": path,
				"head": head,
				"working": working,
				"lang": langFor(path),
				"mode": prefersDark() ? "dark" : "light",
				"rows": rows,
				"deselectedRows": [...(lineDeselect.get(path) ?? [])],
				"onRowSelection": (dropped) => {
					if (dropped.length === 0) {
						lineDeselect.delete(path);
					} else {
						lineDeselect.set(path, new Set(dropped));
					}

					deselected.delete(path); // touching lines means the file is (partially) IN, not fully excluded
					force();
				},
				"classify": async () => {
					const verdict = await classify(head, working);

					return { "verdict": verdict?.verdict ?? "none", "changedLines": verdict?.changedLines ?? [] };
				},
				"onDiscardRows": async (hunkRows) => {
					const fresh = await rpc.request("git.file", { "path": path }) as { "head": string; "working": string };
					const freshRows = buildRows(fresh.head, fresh.working);
					const reverted = committedContent(fresh.head, fresh.working, freshRows, new Set(hunkRows));

					await rpc.request("git.discard", { "path": path, "content": reverted });
				}
			});
			codehikeActive.current = true;
		} catch {
			if (codehikeActive.current) {
				// eslint-disable-next-line require-atomic-updates -- overlay is the shell's fixed set of elements: nothing swaps it across the await
				overlay.title.textContent = path + " — diff unavailable";
			} else {
				renderPlain(head, working);
			}
		}
	};

	const refresh = async (options?: { "timeoutMs": number }): Promise<void> => {
		const { "files": next } = await rpc.request("git.status", undefined, options) as { "files": GitFileChange[] };

		void classifyAll(next);
		const stillChanged = (path: string): boolean => next.some((file) => file.path === path);

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

		setFiles(next);

		// keep the open diff current, or drop it (and close the dialog) if its file is gone
		setSelected((current) => {
			if (current !== undefined && !stillChanged(current)) {
				overlay.el.classList.remove("open");

				return undefined;
			}

			return current;
		});
	};

	// Mount-once wiring: the overlay close button, git.changed refresh, and the initial load.
	useEffect(() => {
		overlay.close.addEventListener("click", hideOverlay);

		const off = hub.subscribe("git.changed", () => {
			void refresh();
		});

		// The workbench git service registers late in its boot (and the shell→app→workbench link takes a moment to
		// form), so the initial load POLLS with a short timeout until the responder answers — instead of one
		// default 15s "no responder" hang. Once up, `git.changed` drives subsequent refreshes.
		void (async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				try {
					await refresh({ "timeoutMs": 1500 });

					return;
				} catch {
					await new Promise((resolve) => {
						setTimeout(resolve, 500);
					});
				}
			}
		})();

		return () => {
			overlay.close.removeEventListener("click", hideOverlay);
			off();
		};
	}, []);

	// Re-mount the diff of the still-open file after a refresh (content may have changed).
	useEffect(() => {
		if (selected !== undefined && files.some((file) => file.path === selected)) {
			void showDiff(selected);
		}
	}, [files]);

	// Follow the OS light/dark scheme: re-highlight the open diff with the matching shiki theme when it flips. The
	// docKey (path) is unchanged, so the diff's fold/selection state survives the re-mount.
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (): void => {
			if (selected !== undefined) {
				void showDiff(selected);
			}
		};

		mq.addEventListener("change", onChange);

		return () => {
			mq.removeEventListener("change", onChange);
		};
	}, [selected]);

	const total = files.length;
	const chosen = files.filter((file) => isIncluded(file.path)).length;
	const anyPartial = files.some((file) => fileState(file.path) === "partial");
	const allChecked = total > 0 && chosen === total && !anyPartial;
	const someChecked = chosen > 0 && (chosen < total || anyPartial);

	const toggleAll = (checked: boolean): void => {
		deselected.clear();
		lineDeselect.clear();

		if (!checked) {
			for (const file of files) {
				deselected.add(file.path);
			}
		}

		force();
	};

	const pickFile = (path: string, checked: boolean): void => {
		lineDeselect.delete(path); // a file-level toggle overrides any per-line selection

		if (checked) {
			deselected.delete(path);
		} else {
			deselected.add(path);
		}

		force();
	};

	const toggleExpand = (path: string): void => {
		setExpanded((current) => {
			const next = new Set(current);

			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
				void showDiff(path); // ensure the diff is open so a chunk-hover has somewhere to spotlight
			}

			return next;
		});
	};

	const commit = async (): Promise<void> => {
		const message = ((msgRef.current as { "value"?: string } | null)?.value ?? "").trim();

		if (message === "") {
			msgRef.current?.focus();

			return;
		}

		const included = files.filter((file) => isIncluded(file.path));

		if (included.length === 0) {
			return;
		}

		setCommitting(true);
		setCommitError(false);

		try {
			// A partial file sends the exact blob to commit (HEAD + selected hunks); a full file names its path (the
			// service stages the working copy) or flags a deletion.
			const payload = await Promise.all(included.map(async (file) => {
				if (fileState(file.path) !== "partial") {
					return { "path": file.path, "deleted": file.status === "D" };
				}

				const { head, working } = await rpc.request("git.file", { "path": file.path }) as { "head": string; "working": string };
				const rows = buildRows(head, working);

				return { "path": file.path, "content": committedContent(head, working, rows, lineDeselect.get(file.path) ?? new Set()) };
			}));

			await rpc.request("git.commit", { "message": message, "files": payload });

			if (msgRef.current !== null) {
				(msgRef.current as { "value": string }).value = "";
			}

			lineDeselect.clear();
			changedCount.clear();
		} catch {
			setCommitError(true);
			setTimeout(() => {
				setCommitError(false);
			}, 1800);
		} finally {
			setCommitting(false);
			void refresh();
		}
	};

	const commitLabel = commitLabelOf(commitError, allChecked, chosen, total);

	return (
		<div class="gp wa-stack wa-gap-0 wa-font-size-s">
			<div class={"gp-head wa-split wa-flex-nowrap wa-gap-xs " + caption()}>
				<span class="wa-cluster wa-flex-nowrap wa-gap-xs">
					<wa-checkbox checked={allChecked} indeterminate={someChecked} title="Select all changes" aria-label="Select all changes" onChange={(event: Event) => { toggleAll((event.target as HTMLInputElement).checked); }} />

					<span>Changes</span>

					<span class="wa-color-text-normal wa-font-weight-semibold">{total}</span>
				</span>

				{headerEnd}
			</div>

			<div class="gp-files">
				{total === 0
					? <div class="gp-empty wa-text-center wa-color-text-quiet">No changes</div>
					: files.map((file) => (
							<Fragment key={file.path}>
								<FileRow
									file={file}
									cosmetic={cosmetic.has(file.path)}
									state={fileState(file.path)}
									current={file.path === selected}
									expanded={expanded.has(file.path)}
									onPick={(checked) => { pickFile(file.path, checked); }}
									onOpen={() => { void showDiff(file.path); }}
									onToggleExpand={() => { toggleExpand(file.path); }}
									onDiscard={() => { void rpc.request("git.discard", { "path": file.path }); }}
								/>

								{expanded.has(file.path) && <Chunks path={file.path} rpc={rpc} onOpen={(path) => { void showDiff(path); }} />}
							</Fragment>
						))}
			</div>

			<div class="gp-commit wa-stack wa-gap-xs">
				<wa-textarea ref={msgRef} rows={2} resize="vertical" placeholder="Summary — describe your changes" />

				<wa-button variant="brand" disabled={chosen === 0 || committing} onClick={() => { void commit(); }}>{commitLabel}</wa-button>
			</div>
		</div>
	);
}

/**
 * Mount the review panel into `container` (files list + commit box), driving the shell's diff `overlay` when a file is
 * opened, and talking to the git service over `hub`.
 */
/** `headerEnd` lands at the right of the panel's header row — the shell puts its collapse button there, so the pane
 *  has ONE "Changes" header rather than the shell's plus the panel's own. */
export function renderGitPanel(container: HTMLElement, overlay: DiffOverlay, hub: Hub, headerEnd?: ComponentChildren): void {
	render(<GitPanel overlay={overlay} hub={hub} headerEnd={headerEnd} />, container);
}
