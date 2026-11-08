/**
 * How a commit did in CI, as the sign-in sees it: `github.actions` (github.ts `actions`), which the workbench's
 * `ci.status` and its status bar item ask (workbench/ci-status.ts).
 */
import type { ShellFeature } from "./feature";
import { serve } from "@brianjenkins94/hub";

export const ci: ShellFeature = {
	"start": ({ hub }) => {
		serve(hub, "github.actions", async (args) => (await import("./github")).actions(args));
	}
};
