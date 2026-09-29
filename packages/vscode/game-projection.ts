/**
 * Game projection client — the workbench-realm handle to the reverse-projection worker (recognizer-worker.ts).
 *
 * Keeps `typescript` OUT of the main bundle: the recognizer runs in the worker (where the shared ts chunk lives) and
 * only the plain-JSON GameModel crosses back. The worker's hub links into the workbench's, and `project` is a
 * `recognizer.project` call over it — on demand, so no serial queue / abort machinery.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, portTransport } from "@brianjenkins94/hub";

import type { GameModel } from "./game-recognizer";

export interface GameProjection {
	/** Project a game's `{ path → source }` into its {behaviors, objects, rules} model. */
	"project": (files: Record<string, string>) => Promise<GameModel>;
	"dispose": () => void;
}

/** Create a projection client backed by the recognizer worker (served at `lsp/recognizer-worker.js`), linked into `hub`. */
export function createGameProjection(hub: Hub): GameProjection {
	const worker = new Worker(new URL("./lsp/recognizer-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	const rpc = createRpcClient(hub);
	// A worker that fails to load (or dies) never answers — fail the in-flight calls, and every later one.
	const dead = new AbortController();

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		dead.abort(new Error("recognizer worker failed: " + (event.message || "could not load")));
	});

	return {
		// Generous limits: the first call waits for the worker to come up and then loads the shared ts chunk.
		"project": async (files) => (await rpc.request("recognizer.project", { "files": files }, { "timeoutMs": 120000, "waitForResponderMs": 30000, "signal": dead.signal })) as GameModel,
		"dispose": () => {
			unlink();
			worker.terminate();
		}
	};
}
