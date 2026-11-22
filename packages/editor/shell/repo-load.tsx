/** @jsxImportSource preact */
import type { ShellContext, ShellFeature } from "./feature";
import type { RepoBinding } from "./github-auth";
import { ghError } from "theme/styles/shell";
import { instance } from "../shared/instance";
import { envRepo, showRepo } from "./address";
import { createStore, errText, githubLog, shared, statusOf, useStore } from "./feature";
import { signInSettled } from "./sign-in";

const state = createStore<{ "input": string; "loading": boolean; "error"?: string }>({ "input": "", "loading": false });

let shell: ShellContext | undefined;

function pickOpenEditors(paths: string[]): string[] {
	const preferred = paths.find((path) => /^readme\.md$/iu.test(path)) ?? paths.find((path) => /\.(?:tsx?|jsx?|html|md)$/iu.test(path)) ?? paths[0];

	return preferred !== undefined ? ["/workspace/" + preferred] : [];
}

async function loadRepo(input = state.get().input): Promise<void> {
	const match = /^([^\s/]+)\/([^\s/]+)$/u.exec(input.trim());

	if (match === null) {
		state.set({ "error": "Use the form owner/repo" });

		return;
	}

	state.set({ "loading": true, "error": undefined });

	const span = githubLog.span("editor.shell.repo-load.githubLoadRepo", { "repo": input.trim() });

	try {
		const [, owner, repo] = match;
		const signedIn = await (await import("./session")).viaProxy();
		const { connectGitHub } = await import("./github");
		const gh = await connectGitHub();
		const meta = await gh.getRepo(owner, repo);

		if (meta === undefined) {
			state.set({ "error": signedIn ? "Repo not found, or not one you've given the editor access to." : "Repo not found. A private one needs you signed in with GitHub." });
			span.error("repo not found or not visible");

			return;
		}

		let files: { "path": string; "bytes": Uint8Array }[];

		try {
			const { cloneRepo } = await import("./git-clone");

			({ files } = await cloneRepo(owner, repo, signedIn));
			span.info("cloned", { "files": files.length });
		} catch (error) {
			span.warn("clone failed — reading through the API", { "error": errText(error) });
			files = await gh.readRepo(owner, repo);
		}

		if (files.length === 0) {
			state.set({ "error": "That repo has no files" });
			span.error("repo has no files", { "branch": meta.default_branch });

			return;
		}

		const projectFiles = files.map((file) => ({ "path": "/workspace/" + file.path, "bytes": file.bytes }));

		shell?.hub.publish("project.openFiles", { "files": projectFiles, "openEditors": pickOpenEditors(files.map((file) => file.path).filter((path) => !path.startsWith(".git/"))) });

		const binding = { "owner": owner, "repo": repo, "branch": meta.default_branch };

		shared.set({ "boundRepo": binding, "githubOpen": false });
		showRepo(binding);
		shell?.hub.publish("session.event", { "name": "repo.loaded", "detail": `${owner}/${repo}` });
		state.set({ "input": "" });
		span.info("loaded", { "branch": meta.default_branch, "files": files.length, "bytes": files.reduce((total, file) => total + file.bytes.length, 0) });
	} catch (error) {
		state.set({ "error": error instanceof Error ? error.message : "Could not load the repo" });
		span.error("load failed", { "error": errText(error), "status": statusOf(error) });
	} finally {
		span.end();
		state.set({ "loading": false });
	}
}

async function fromAddress(rpc: ShellContext["rpc"]): Promise<void> {
	await signInSettled;

	const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { "locks"?: LockManager }).locks;

	if (locks === undefined) {
		await fromAddressNow(rpc);

		return;
	}

	const ran = await locks.request(`editor.repo-load${instance === undefined ? "" : `.${instance}`}`, { "ifAvailable": true }, async (lock) => {
		if (lock === null) {
			return false;
		}

		await fromAddressNow(rpc);

		return true;
	});

	if (!ran && envRepo() !== undefined) {
		githubLog.info("another tab is loading into this workspace: this one waits for a reload");
		shared.set({ "githubOpen": true });
		state.set({ "error": "Another tab of the editor is loading a repository into this workspace. Reload this tab once it's done to see it here." });
	}
}

async function fromAddressNow(rpc: ShellContext["rpc"]): Promise<void> {
	const wanted = envRepo();

	const asked = await rpc.request("git.origin", undefined, { "timeoutMs": 10_000, "waitForResponderMs": 120_000 }).then((origin) => ({ "origin": origin as RepoBinding | null }), (error: unknown) => ({ "error": errText(error) }));

	if ("error" in asked) {
		githubLog.warn("the workspace's origin went unanswered: it's kept", asked);

		return;
	}

	const bound = asked.origin ?? undefined;

	shared.set({ "boundRepo": bound });

	if (wanted === undefined || `${bound?.owner}/${bound?.repo}`.toLowerCase() === `${wanted.owner}/${wanted.repo}`.toLowerCase()) {
		return;
	}

	shared.set({ "githubOpen": true });

	if (bound !== undefined) {
		state.set({ "input": `${wanted.owner}/${wanted.repo}`, "error": `This workspace is ${bound.owner}/${bound.repo}: Load replaces it, and whatever of it isn't pushed.` });

		return;
	}

	await loadRepo(`${wanted.owner}/${wanted.repo}`);
}

export function LoadSection() {
	const { githubUser } = useStore(shared);
	const { input, loading, error } = useStore(state);

	return (
		<>
			<span class="wa-font-weight-semibold wa-font-size-s">{githubUser === undefined ? "Load a public repo" : "Load a repo"}</span>

			<span class="wa-caption-2xs">Its files open in the workspace.</span>

			<wa-input
				size="small"
				placeholder="owner/repo"
				value={input}
				autocapitalize="off"
				autocorrect="off"
				spellcheck={false}
				aria-label="Repository to load"
				onInput={(event: Event) => { state.set({ "input": (event.currentTarget as HTMLInputElement).value }); }}
				onKeyDown={(event: KeyboardEvent) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void loadRepo();
					}
				}}
			/>

			{error !== undefined && <span class={"wa-caption-2xs " + ghError()}>{error}</span>}

			<div class="wa-cluster wa-gap-xs">
				<wa-button variant="brand" size="small" disabled={loading || input.trim() === ""} onClick={() => { void loadRepo(); }}>{loading ? "Loading…" : "Load"}</wa-button>
			</div>
		</>
	);
}

export const repoLoad: ShellFeature = {
	"start": (given) => {
		shell = given;
		void fromAddress(given.rpc);
	}
};
