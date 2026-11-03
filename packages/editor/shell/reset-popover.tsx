/** @jsxImportSource preact */
/**
 * The top bar's Reset: what goes, what it would lose here — the workspace's uncommitted changes and the commits no
 * remote has, counted as it opens — and the reset itself (reset.ts, from the address), signing out too if asked.
 */
import type { ShellContext, ShellFeature } from "./feature";
import { RotateCcw } from "lucide";
import { useState } from "preact/hooks";
import { ghError, popoverBody } from "theme/styles/shell";
import { Icon } from "./icon";
import { resetAddress } from "./reset";

interface Losing { "changes": number; "unpushed": { "branch": string; "commits": number }[] }

/** What a reset would lose, in words: "3 uncommitted changes and 2 commits not pushed (on rehearsal/cosmetic) would be lost." */
function lossOf({ changes, unpushed }: Losing): string {
	const commits = unpushed.reduce((total, { "commits": count }) => total + count, 0);
	const parts = [
		...changes === 0 ? [] : [`${String(changes)} uncommitted change${changes === 1 ? "" : "s"}`],
		...commits === 0 ? [] : [`${String(commits)} commit${commits === 1 ? "" : "s"} not pushed (on ${unpushed.map(({ branch }) => branch).join(", ")})`]
	];

	return `${parts.join(" and ")} would be lost.`;
}

function ResetControl({ shell }: { "shell": ShellContext }) {
	const [open, setOpen] = useState(false);
	// (null: they couldn't be counted)
	const [losing, setLosing] = useState<Losing | null | undefined>(undefined);
	const [signOut, setSignOut] = useState(false);

	const count = async (): Promise<void> => {
		setOpen(true);
		setLosing(undefined);

		const [status, unpushed] = await Promise.all([
			shell.rpc.request("git.status", undefined, { "timeoutMs": 30_000 }).then((answer) => answer as { "files": unknown[] }, () => undefined),
			shell.rpc.request("git.unpushed", undefined, { "timeoutMs": 30_000 }).then((answer) => answer as { "branch": string; "commits": number }[], () => undefined)
		]);

		setLosing(status === undefined || unpushed === undefined ? null : { "changes": status.files.length, "unpushed": unpushed });
	};

	return (
		<>
			<wa-button id="shell-reset" appearance="plain" size="small" title="Reset the editor" aria-label="Reset the editor"><Icon node={RotateCcw} /></wa-button>

			<wa-popover
				for="shell-reset"
				placement="bottom-end"
				open={open}
				onwa-show={(event: Event) => {
					if (event.target === event.currentTarget) {
						void count();
					}
				}}
				onwa-hide={(event: Event) => {
					if (event.target === event.currentTarget) {
						setOpen(false);
					}
				}}
			>
				<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Reset the editor">
					<span class="wa-font-weight-semibold wa-font-size-s">Reset the editor</span>

					<span class="wa-caption-2xs">Everything this browser keeps for the editor goes — the workspace and its git, settings, caches, its service worker — and it loads again as new.</span>

					{losing === undefined
						? <span class="wa-caption-2xs">Counting what isn't pushed…</span>
						: losing === null
							? <span class={"wa-caption-2xs " + ghError()}>Couldn't count what isn't pushed: anything here not pushed is lost.</span>
							: losing.changes === 0 && losing.unpushed.length === 0
								? <span class="wa-caption-2xs">Everything here is committed and pushed.</span>
								: <span class={"wa-caption-2xs " + ghError()}>{lossOf(losing)}</span>}

					<wa-checkbox size="small" checked={signOut} onChange={(event: Event) => { setSignOut((event.target as HTMLInputElement).checked); }}>Sign out too</wa-checkbox>

					<div class="wa-cluster wa-gap-xs">
						<wa-button variant="danger" size="small" onClick={() => { location.assign(resetAddress(signOut)); }}>Reset</wa-button>
					</div>
				</div>
			</wa-popover>
		</>
	);
}

export const reset: ShellFeature = { "control": { "place": "end", "Control": ResetControl } };
