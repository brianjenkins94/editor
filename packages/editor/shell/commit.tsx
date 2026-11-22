/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import type { ShellContext, ShellFeature } from "./feature";
import { GitCommit } from "lucide";
import { useState } from "preact/hooks";
import { ghError, ghOk, popoverBody } from "theme/styles/shell";
import { errText, githubLog, shared, statusOf, useStore } from "./feature";
import { Icon } from "./icon";

export interface CommitOutcome { "said": string; "failed": boolean; "made"?: string }

interface Pulled { "ref": string; "outcome": string; "files"?: string[]; "conflicts"?: string[] }

export async function commitAndPush(rpc: Pick<ShellContext["rpc"], "request">, message: string, repo: string): Promise<CommitOutcome> {
	const span = githubLog.span("editor.shell.commit.githubCommit", { "repo": repo });
	let made: string | undefined;
	let tests = "";
	const commit = async (): Promise<string> => {
		const committed = await rpc.request("git.commit", { "message": message }, { "timeoutMs": 600_000 }) as { "oid": string; "tests"?: string };

		tests = committed.tests === undefined ? "" : `. ${committed.tests}`;

		return committed.oid.slice(0, 7);
	};

	try {
		const pull = async (): Promise<Pulled> => rpc.request("git.pull", {}, { "timeoutMs": 300_000 }) as Promise<Pulled>;
		let pulled = await pull();

		if (pulled.outcome === "conflicts") {
			throw new Error(`GitHub changed files you've changed here, so it can't catch up: ${(pulled.conflicts ?? []).join(", ")}`);
		}

		if (pulled.outcome === "diverged") {
			made = await commit();
			pulled = await pull();
		}

		if (pulled.outcome === "merge conflicts") {
			throw new Error(`GitHub and this workspace changed the same lines of ${(pulled.conflicts ?? []).join(", ")}: both are marked in the file${pulled.conflicts?.length === 1 ? "" : "s"}. Settle them and commit again, and that commit is the merge`);
		}

		const caught = pulled.outcome === "fast-forwarded" || pulled.outcome === "merged" ? `${pulled.outcome === "merged" ? "Merged" : "Caught up with"} GitHub (${String(pulled.files?.length ?? 0)} files). ` : "";
		const { files } = await rpc.request("git.status", undefined, { "timeoutMs": 120_000 }) as { "files": { "path": string }[] };
		const changed = files.filter(({ path }) => path !== ".silo/.gitignore" && path !== ".silo/.gitattributes");

		if (changed.length > 0 && made === undefined) {
			made = await commit();
		}

		const pushed = await rpc.request("git.push", {}, { "timeoutMs": 300_000 }) as { "ref": string; "ok": boolean; "error"?: string };

		if (!pushed.ok) {
			throw new Error(`GitHub refused the push to ${pushed.ref}${pushed.error === undefined ? "" : `: ${pushed.error}`}`);
		}

		span.info("committed and pushed", { "files": changed.length, "ref": pushed.ref, "pulled": pulled.outcome, ...made === undefined ? {} : { "sha": made } });

		return { "said": caught + (made === undefined ? `Nothing to commit: pushed ${pushed.ref}` : `Committed ${made} and pushed ${pushed.ref}${tests}`), "failed": false, ...made === undefined ? {} : { "made": made } };
	} catch (failure) {
		const text = failure instanceof Error ? failure.message : "Commit failed";

		span.error("commit or push failed", { "error": errText(failure), "status": statusOf(failure), ...made === undefined ? {} : { "sha": made } });

		return { "said": made === undefined ? text : `Committed ${made}, but not pushed: ${text}${tests}`, "failed": true, ...made === undefined ? {} : { "made": made } };
	} finally {
		span.end();
	}
}

function CommitControl({ shell }: { "shell": ShellContext }) {
	const { githubUser, boundRepo } = useStore(shared);
	const [open, setOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [committing, setCommitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [result, setResult] = useState<string | undefined>(undefined);
	const [branch, setBranch] = useState<string | undefined>(undefined);

	const commit = async (): Promise<void> => {
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

		const done = await commitAndPush(shell.rpc, said, boundRepo.owner + "/" + boundRepo.repo);

		if (done.made !== undefined) {
			setMessage("");
		}

		if (done.failed) {
			setError(done.said);
		} else {
			setResult(done.said);
		}

		setCommitting(false);
	};

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
