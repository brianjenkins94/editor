/** @jsxImportSource preact */
/**
 * The top bar's Commit: the workspace's changes committed and pushed — the workbench's git (git-service.ts `git.pull`,
 * `git.commit` with every change, then `git.push` of the current branch, through this shell's sign-in: git-push.ts), as
 * agents' git_pull, git_commit and git_push do and the review panel commits a part of. First the branch is brought up
 * to GitHub's when that's a fast-forward (CI commits to main too), so the push is one; when it can't be — the two have
 * each moved on, or GitHub changed a file changed here — nothing is committed, and it says why. With nothing changed,
 * it pushes what's committed and not yet pushed. A push refused after the commit says so: the commit is made, and
 * pushing again is the button again.
 */
import type { ComponentChildren } from "preact";
import type { ShellContext, ShellFeature } from "./feature";
import { GitCommit } from "lucide";
import { useState } from "preact/hooks";
import { ghError, ghOk, popoverBody } from "theme/styles/shell";
import { errText, githubLog, shared, statusOf, useStore } from "./feature";
import { Icon } from "./icon";

function CommitControl({ shell }: { "shell": ShellContext }) {
	const { githubUser, boundRepo } = useStore(shared);
	const [open, setOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [committing, setCommitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [result, setResult] = useState<string | undefined>(undefined);
	// (the branch a push goes to: the workspace's own, asked as the popover opens — a checkout since the load moves it)
	const [branch, setBranch] = useState<string | undefined>(undefined);

	const commit = async (): Promise<void> => {
		const { rpc } = shell;
		const said = message.trim();

		if (boundRepo === undefined) {
			setError("Load a repo first");

			return;
		}

		if (said === "") {
			setError("Enter a commit message");

			return;
		}

		setCommitting(true);
		setError(undefined);
		setResult(undefined);

		const span = githubLog.span("editor.shell.githubCommit", { "repo": boundRepo.owner + "/" + boundRepo.repo });
		let made: string | undefined;

		try {
			const pulled = await rpc.request("git.pull", {}, { "timeoutMs": 300_000 }) as { "ref": string; "outcome": string; "files"?: string[]; "conflicts"?: string[] };

			if (pulled.outcome === "diverged") {
				throw new Error(`GitHub's ${pulled.ref} and this workspace's have each moved on, so it can't catch up: that's a rebase or a merge`);
			}

			if (pulled.outcome === "conflicts") {
				throw new Error(`GitHub changed files you've changed here, so it can't catch up: ${(pulled.conflicts ?? []).join(", ")}`);
			}

			const caught = pulled.outcome === "fast-forwarded" ? `Caught up with GitHub (${String(pulled.files?.length ?? 0)} files). ` : "";
			// (a commit of every change reads every file's status: on this repository, 2,212 files with the page busy after its
			// load, more than a minute — as git_review's and git_commit's tools allow)
			const { files } = await rpc.request("git.status", undefined, { "timeoutMs": 120_000 }) as { "files": { "path": string }[] };
			// (`.silo/`'s own .gitignore and .gitattributes alone are nothing to commit: they go only with something else
			// under `.silo/`, git-engine.ts `stageSiloSeeds`)
			const changed = files.filter(({ path }) => path !== ".silo/.gitignore" && path !== ".silo/.gitattributes");

			if (changed.length > 0) {
				made = (await rpc.request("git.commit", { "message": said }, { "timeoutMs": 600_000 }) as { "oid": string }).oid.slice(0, 7);
				setMessage("");
			}

			const pushed = await rpc.request("git.push", {}, { "timeoutMs": 300_000 }) as { "ref": string; "ok": boolean; "error"?: string };

			if (!pushed.ok) {
				throw new Error(`GitHub refused the push to ${pushed.ref}${pushed.error === undefined ? "" : `: ${pushed.error}`}`);
			}

			setResult(caught + (made === undefined ? `Nothing to commit: pushed ${pushed.ref}` : `Committed ${made} and pushed ${pushed.ref}`));
			span.info("committed and pushed", { "files": changed.length, "ref": pushed.ref, "pulled": pulled.outcome, ...made === undefined ? {} : { "sha": made } });
		} catch (failure) {
			const text = failure instanceof Error ? failure.message : "Commit failed";

			setError(made === undefined ? text : `Committed ${made}, but not pushed: ${text}`);
			span.error("commit or push failed", { "error": errText(failure), "status": statusOf(failure), ...made === undefined ? {} : { "sha": made } });
		} finally {
			span.end();
			setCommitting(false);
		}
	};

	// The popover's body: what it needs first, until it has it — then the repo it pushes to, and the message.
	const body = (): ComponentChildren => {
		if (githubUser === undefined) {
			return <span class="wa-caption-2xs">Sign in with GitHub first.</span>;
		}

		if (boundRepo === undefined) {
			return <span class="wa-caption-2xs">Load a repo first — a commit is pushed to the repo the workspace came from.</span>;
		}

		return (
			<>
				<span class="wa-caption-2xs">
					To
					{" "}

					<strong>
						{boundRepo.owner}
						/

						{boundRepo.repo}
					</strong>

					{" "}
					on

					{" "}

					<strong>{branch ?? boundRepo.branch}</strong>
				</span>

				<wa-input
					size="small"
					placeholder="Commit message"
					value={message}
					aria-label="Commit message"
					onInput={(event: Event) => { setMessage((event.currentTarget as HTMLInputElement).value); }}
					onKeyDown={(event: KeyboardEvent) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void commit();
						}
					}}
				/>

				{error !== undefined && <span class={"wa-caption-2xs " + ghError()}>{error}</span>}

				{result !== undefined && (
					<span class={"wa-caption-2xs " + ghOk()}>
						{result}
					</span>
				)}

				<div class="wa-cluster wa-gap-xs">
					<wa-button variant="brand" size="small" disabled={committing || message.trim() === ""} onClick={() => { void commit(); }}>{committing ? "Committing…" : "Commit and push"}</wa-button>
				</div>
			</>
		);
	};

	return (
		<>
			<wa-button
				id="shell-commit"
				appearance="plain"
				size="small"
				title={boundRepo !== undefined ? "Commit and push to " + boundRepo.owner + "/" + boundRepo.repo : "Commit and push"}
				aria-label="Commit"
			>
				<Icon node={GitCommit} />
			</wa-button>

			<wa-popover
				for="shell-commit"
				placement="bottom-start"
				open={open}
				onwa-show={(event: Event) => {
					if (event.target === event.currentTarget) {
						setError(undefined);
						setResult(undefined);
						setOpen(true);
						void shell.rpc.request("git.branch", undefined, { "timeoutMs": 10_000 }).then((branches) => {
							setBranch((branches as { "current"?: string }).current);
						}, () => {
							setBranch(undefined);
						});
					}
				}}
				onwa-hide={(event: Event) => {
					if (event.target === event.currentTarget) {
						setOpen(false);
					}
				}}
			>
				<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Commit to GitHub">
					<span class="wa-font-weight-semibold wa-font-size-s">Commit and push</span>

					{body()}
				</div>
			</wa-popover>
		</>
	);
}

export const commit: ShellFeature = { "control": { "place": "start", "Control": CommitControl } };
