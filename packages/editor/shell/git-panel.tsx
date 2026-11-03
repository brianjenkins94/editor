/** @jsxImportSource preact */
/**
 * Git review panel — a GitHub-Desktop-style changed-files + diff + commit surface, rendered in the SHELL's RHS chrome
 * (not the vscode SCM viewlet). Built on Web Awesome components (wa-checkbox / wa-textarea / wa-button / wa-badge) and
 * utility classes in a preact tree; what's left in theme/styles/git-panel is the rows' hover/current states and
 * the side-by-side diff renderer's grid. It's a pure hub consumer: it calls
 * `git.status` / `git.review` / `git.commit` / `git.discard` (served by git-service.ts and git-review.ts in the workbench realm) over the
 * shell hub, and refreshes on `git.changed`. What a pick of lines commits or discards is the service's (shared/git-hunks.ts),
 * as it is for an agent's `git_commit` / `git_discard` by hunk: the panel only says which rows. No monaco, no zen-fs here — the "novel review UI over the engine" the git-engine
 * decoupling was for. The diff opens in a shell-owned overlay the codehike island mounts into (overlay.body).
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { ComponentChildren } from "preact";
import type { DiffRowInfo, Review, ReviewFile } from "../shared/git-hunks";
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
import { gitPanelStyles } from "theme/styles/git-panel";

gitPanelStyles();

interface DiffRow { "t": "ctx" | "add" | "del"; "text": string }

/**
 * The diff dialog — a shell-owned overlay that covers the editor when a file is opened. The shell hands us its four
 * elements; we drive them imperatively (codehike mounts a React root into `body`, so it stays outside preact).
 */
export interface DiffOverlay { "el": HTMLElement; "title": HTMLElement; "body": HTMLElement; "close": HTMLElement }

/** The plain diff's lines, from the aligned rows: a modified row as its deletion, then its addition. */
function plainRows(head: string, working: string, rows: DiffRowInfo[]): DiffRow[] {
	const [headLines, workingLines] = [head.split("\n"), working.split("\n")];

	return rows.flatMap((row): DiffRow[] => {
		const [left, right]: DiffRow[] = [{ "t": "del", "text": headLines[row.leftNo - 1] }, { "t": "add", "text": workingLines[row.rightNo - 1] }];

		const sides: Record<DiffRowInfo["type"], DiffRow[]> = { "ctx": [{ "t": "ctx", "text": workingLines[row.rightNo - 1] }], "add": [right], "del": [left], "mod": [left, right] };

		return sides[row.type];
	});
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

/** Current OS colour scheme — the diff highlights with the matching shiki theme (the shell drives the same query). */
const prefersDark = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** A file's status letter, by the Web Awesome variant it's drawn in: added, modified, deleted. */
const STATUS_VARIANTS: Record<GitFileChange["status"], string> = { "A": "success", "M": "warning", "D": "danger" };

/** One changed-file row: tri-state pick, status, name, and a tail (discard). */
function FileRow({ file, state, current, onPick, onOpen, onDiscard }: {
	"file": GitFileChange;
	"state": "all" | "partial" | "off";
	"current": boolean;
	"onPick": (checked: boolean) => void;
	"onOpen": () => void;
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
		if ((event.target as HTMLElement).closest("wa-checkbox, .gp-discard") === null) {
			onOpen();
		}
	};

	return (
		<div class="gp-file wa-cluster wa-flex-nowrap wa-gap-xs" aria-current={current} onClick={clickRow}>
			<wa-checkbox checked={state !== "off"} indeterminate={state === "partial"} onChange={(event: Event) => { onPick((event.target as HTMLInputElement).checked); }} />

			<wa-badge class="gp-status" variant={STATUS_VARIANTS[file.status]} appearance="filled">{file.status}</wa-badge>

			<span class="gp-name wa-text-truncate"><bdi dir="ltr">{file.path}</bdi></span>

			<span class="wa-cluster wa-flex-nowrap wa-gap-2xs">

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
	const [selected, setSelected] = useState<string | undefined>(undefined);
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
	const renderPlain = (head: string, working: string, rows: DiffRowInfo[]): void => {
		const diff = document.createElement("div");

		diff.className = "sxs-plain";

		for (const row of collapse(plainRows(head, working, rows))) {
			const line = document.createElement("div");

			line.className = "sxs-plain-row " + row.t;
			line.textContent = ROW_MARKS[row.t] + row.text;
			diff.appendChild(line);
		}

		overlay.body.replaceChildren(diff);
	};

	/** The working tree as `git.review` has it, for the files given (default, every change). */
	const review = async (request: { "paths"?: string[]; "texts"?: boolean }): Promise<ReviewFile[]> => (await rpc.request("git.review", request, { "timeoutMs": 600_000 }) as Review).files;

	const showDiff = async (path: string): Promise<void> => {
		setSelected(path);

		const [shown] = await review({ "paths": [path], "texts": true });

		if (shown === undefined) {
			hideOverlay(); // no change left to show

			return;
		}

		const { head = "", working = "", rows = [] } = shown;

		overlay.title.textContent = path;
		overlay.el.classList.add("open");

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
				"onDiscardRows": async (hunkRows) => {
					await rpc.request("git.discard", { "path": path, "rows": hunkRows });
				}
			});
			codehikeActive.current = true;
		} catch {
			if (codehikeActive.current) {
				// eslint-disable-next-line require-atomic-updates -- overlay is the shell's fixed set of elements: nothing swaps it across the await
				overlay.title.textContent = path + " — diff unavailable";
			} else {
				renderPlain(head, working, rows);
			}
		}
	};

	const refresh = async (options?: { "timeoutMs": number }): Promise<void> => {
		const { "files": next } = await rpc.request("git.status", undefined, options) as { "files": GitFileChange[] };

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

	// A refresh nobody waits on: if the workbench is too busy to answer (a large repository loading), the list stays as
	// it was until the next `git.changed`, rather than the timeout going up as an uncaught error.
	const refreshLater = (): void => {
		refresh().catch(() => { /* the next git.changed refreshes */ });
	};

	// Mount-once wiring: the overlay close button, git.changed refresh, and the initial load.
	useEffect(() => {
		overlay.close.addEventListener("click", hideOverlay);

		const off = hub.subscribe("git.changed", refreshLater);

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
			// A partial file names the changed rows it leaves out (the service commits HEAD with the rest); a full file,
			// only its path.
			const payload = included.map((file) => (fileState(file.path) === "partial" ? { "path": file.path, "except": [...lineDeselect.get(file.path) ?? []] } : { "path": file.path }));

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
			refreshLater();
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
									state={fileState(file.path)}
									current={file.path === selected}
									onPick={(checked) => { pickFile(file.path, checked); }}
									onOpen={() => { void showDiff(file.path); }}
									onDiscard={() => { void rpc.request("git.discard", { "path": file.path }); }}
								/>
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
