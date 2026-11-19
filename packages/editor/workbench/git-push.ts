/**
 * The workspace's git and GitHub: its branches, and a branch pulled from or pushed to the repository it was cloned
 * from. The workbench has the repository and makes a remote's requests; the shell has the sign-in and sends them
 * (`git.remote`, shell/git-push.ts; shared/git-remote.ts).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { HttpClient } from "isomorphic-git";
import type { RemoteResponse } from "../shared/git-remote";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { remoteHttp } from "../shared/git-remote";
import * as engine from "./git-engine";

/** Serve `git.branch`, `git.checkout`, `git.fetch`, `git.pull` and `git.push` on `hub`; the remote, as the shell reaches it, for
 *  whoever else fetches (git-history.ts). */
export function installGitPush(hub: Hub, log: Logger): HttpClient {
	const shell = createRpcClient(hub);

	// The branches; with a `name`, one made at HEAD (`git branch <name>`).
	serve(hub, "git.branch", async (args) => {
		const name = (args as { "name"?: unknown } | null)?.name;

		if (typeof name === "string" && name !== "") {
			await engine.createBranch(name);
		}

		return engine.branches();
	});
	const remote = remoteHttp(async (request) => await shell.request("git.remote", request, { "timeoutMs": 300_000 }) as RemoteResponse);
	// A remote's refusal says why in its answer's body (the proxy's `{ "error": … }`, GitHub's "Permission … denied"):
	// isomorphic-git keeps it on the error and says only "HTTP Error: 403".
	const said = (error: unknown): never => {
		const body = (error as { "data"?: { "response"?: unknown } } | null)?.data?.response;

		throw typeof body === "string" && body.trim() !== "" ? new Error(`${(error as Error).message}: ${body.trim().slice(0, 300)}`) : error;
	};

	// Onto another branch — made at HEAD first with `create` (`git switch -c`), the working tree as it is. One the clone
	// hasn't (it's one commit deep, its own branch only) is fetched from the repository first, one commit deep, and made
	// from origin's, as `git switch <name>` does.
	serve(hub, "git.checkout", async (args) => {
		const { name, create } = (args ?? {}) as { "name"?: unknown; "create"?: unknown };

		if (typeof name !== "string" || name === "") {
			throw new TypeError("git.checkout needs a branch name.");
		}

		if (create !== true && !(await engine.branches()).all.includes(name)) {
			const url = await engine.githubRemote();

			if (url === undefined || !await engine.fetchRef(remote, url, name).catch(said)) {
				throw new Error(`${name} isn't a branch here${url === undefined ? "" : " or on GitHub"} (git switch -c ${name} makes it)`);
			}
		}

		await engine.switchBranch(name, create === true);
		hub.publish("git.changed");

		return engine.branches();
	});

	// A branch (the current one, by default) brought up to the repository's, when that's a fast-forward: what GitHub has
	// that this workspace hasn't, its files written over a working tree whose changes are elsewhere (git-engine.ts `pull`).
	serve(hub, "git.pull", async (args) => {
		const { ref } = (args ?? {}) as { "ref"?: unknown };
		const url = await engine.githubRemote();

		if (url === undefined) {
			throw new Error("this workspace wasn't loaded from a GitHub repository, so there's nothing to bring it up to");
		}

		const pulled = await engine.pull(remote, url, typeof ref === "string" && ref !== "" ? ref : undefined).catch(said);

		if (pulled.outcome === "fast-forwarded") {
			hub.publish("git.changed");
		}

		log.info("git pull", { "ref": pulled.ref, "outcome": pulled.outcome, "files": pulled.files?.length });

		return { ...pulled, "url": url };
	});

	// What the repository has that this workspace hasn't (`git fetch`), the branch left where it is; with `deepen`, that
	// many commits more of the history a shallow clone ends (`unshallow`, all of it) — so `git log` sees past one commit.
	serve(hub, "git.fetch", async (args) => {
		const { ref, deepen, unshallow } = (args ?? {}) as { "ref"?: unknown; "deepen"?: unknown; "unshallow"?: unknown };
		const url = await engine.githubRemote();

		if (url === undefined) {
			throw new Error("this workspace wasn't loaded from a GitHub repository, so there's nothing to fetch from");
		}

		if (deepen !== undefined && !(Number.isInteger(deepen) && (deepen as number) > 0)) {
			throw new TypeError("git.fetch's deepen is a number of commits, more than none");
		}

		const fetched = await engine.fetchBranch(remote, url, typeof ref === "string" && ref !== "" ? ref : undefined, unshallow === true ? Infinity : deepen as number | undefined).catch(said);

		hub.publish("git.changed");
		log.info("git fetch", { "ref": fetched.ref, "commits": fetched.commits, "shallow": fetched.shallow });

		return { ...fetched, "url": url };
	});

	// A branch (the current one, by default) pushed to the repository it was cloned from, through the shell.
	serve(hub, "git.push", async (args) => {
		const { ref, force } = (args ?? {}) as { "ref"?: unknown; "force"?: unknown };
		const url = await engine.githubRemote();

		if (url === undefined) {
			throw new Error("this workspace wasn't loaded from a GitHub repository, so there's nowhere to push it");
		}

		const pushed = await engine.push(remote, url, typeof ref === "string" && ref !== "" ? ref : undefined, force === true).catch(said);

		log.info("git push", { "ref": pushed.ref, "ok": pushed.ok });

		return { ...pushed, "url": url };
	});

	return remote;
}
