import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import * as engine from "./git-engine";

export function serveUnpushed(hub: Hub): void {
	serve(hub, "git.unpushed", async () => engine.unpushed());
}
