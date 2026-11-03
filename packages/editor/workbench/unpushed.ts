/** The commits only this workspace holds, by branch: what a reset or a load would lose that a status doesn't show — the
 *  shell's Reset says so before it clears (shell/reset.ts). */
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import * as engine from "./git-engine";

export function serveUnpushed(hub: Hub): void {
	serve(hub, "git.unpushed", async () => engine.unpushed());
}
