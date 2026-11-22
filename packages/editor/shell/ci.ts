import type { ShellFeature } from "./feature";
import { serve } from "@brianjenkins94/hub";

export const ci: ShellFeature = {
	"start": ({ hub }) => {
		serve(hub, "github.actions", async (args) => (await import("./github")).actions(args));
	}
};
