/**
 * A push from the workspace's git, and who its commits are by: the sign-in's, so the shell's — `git.remote` and
 * `git.identity`, which the workbench's git asks (git-push.ts, loaded when first asked).
 */
import type { RemoteRequest } from "../shared/git-remote";
import type { ShellFeature } from "./feature";
import { serve } from "@brianjenkins94/hub";

export const push: ShellFeature = {
	"start": ({ hub }) => {
		serve(hub, "git.remote", async (args) => (await import("./git-push")).remote(args as RemoteRequest));
		serve(hub, "git.identity", async () => (await import("./git-push")).identity());
	}
};
