/**
 * Game projection client — the workbench-realm handle to the reverse-projection worker (recognizer-worker.ts).
 *
 * Keeps `typescript` OUT of the main bundle: the recognizer runs in the worker (where the shared ts chunk lives) and
 * only the plain-JSON GameModel crosses back. Mirrors cosmetic-classifier.ts's worker plumbing, but projection is
 * on-demand (a request/response keyed by id), so no serial queue / abort machinery.
 */
import type { GameModel } from "./game-recognizer";

export interface GameProjection {
	/** Project a game's `{ path → source }` into its {behaviors, objects, rules} model. */
	"project": (files: Record<string, string>) => Promise<GameModel>;
	"dispose": () => void;
}

/** Create a projection client backed by the recognizer worker (served at `lsp/recognizer-worker.js`). */
export function createGameProjection(): GameProjection {
	const worker = new Worker(new URL("./lsp/recognizer-worker.js", location.href), { "type": "module" });
	const pending = new Map<number, { "resolve": (model: GameModel) => void; "reject": (error: unknown) => void }>();
	let nextId = 0;

	worker.addEventListener("message", (event: MessageEvent<{ "id": number; "model"?: GameModel; "error"?: string }>) => {
		const request = pending.get(event.data.id);

		if (request === undefined) {
			return;
		}

		pending.delete(event.data.id);

		if (event.data.error !== undefined) {
			request.reject(new Error(event.data.error));
		} else {
			request.resolve(event.data.model ?? { "behaviors": [], "composites": [], "objects": [], "rules": [] });
		}
	});

	// A worker that fails to load (or dies) never replies — reject everything pending instead of hanging, and every later call.
	let failure: Error | undefined;

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		failure = new Error("recognizer worker failed: " + (event.message || "could not load"));

		for (const request of pending.values()) {
			request.reject(failure);
		}

		pending.clear();
	});

	return {
		"project": (files) => new Promise<GameModel>((resolve, reject) => {
			if (failure !== undefined) {
				reject(failure);

				return;
			}

			const id = nextId;

			nextId += 1;
			pending.set(id, { "resolve": resolve, "reject": reject });
			worker.postMessage({ "id": id, "files": files });
		}),
		"dispose": () => { worker.terminate(); }
	};
}
