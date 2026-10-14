/**
 * How a failure is said, wherever it happens: an error with where it was thrown, and a worker's failure by the worker's
 * name, said once, by whoever started it.
 *
 * A worker's uncaught error that nobody handles goes up to whoever started it, and on up from there: a debug worker that
 * couldn't load was said by the extension host and again by the workbench, each under its own name, and never as the
 * debug worker's. Watched, it's said here, by its name, and goes no further.
 */

/** An error as text: its stack (which says where it was thrown) when it has one, else its message, else the value. */
export function failureText(error: unknown): string {
	if (error instanceof Error) {
		return error.stack?.includes(error.message) === true ? error.stack : `${error.name}: ${error.message}${error.stack === undefined ? "" : "\n" + error.stack}`;
	}

	return String(error as string | number | boolean | null | undefined);
}

/**
 * Watch a worker started as `name`: its failure to load, or an uncaught error in it, is said by its name, with where it
 * happened (`[debug-worker] couldn't load: ReferenceError: process is not defined (…/lsp/debug-worker.js:12)`), and kept
 * from going on up. A bootstrapped worker (an extension's start classic, and import their module) says it couldn't load
 * with `{ failed }`; that counts too. `onFailed` hears it, and whether the worker had loaded (said anything) before.
 */
export function watchWorker(worker: Worker, name: string, onFailed?: (message: string, loaded: boolean) => void): void {
	let loaded = false;

	const fail = (message: string): void => {
		console.error(`[${name}] ${loaded ? "uncaught error" : "couldn't load"}: ${message}`);
		onFailed?.(message, loaded);
	};

	worker.addEventListener("message", (event: MessageEvent) => {
		const failed = (event.data as { "failed"?: unknown } | null | undefined)?.failed;

		if (typeof failed === "string") {
			fail(failed);
		} else {
			loaded = true;
		}
	});

	worker.addEventListener("error", (event: ErrorEvent) => {
		event.preventDefault();
		// (a module that couldn't be fetched or parsed says nothing but that it failed)
		fail(`${event.message === "" ? "the module couldn't be fetched or parsed" : event.message}${event.filename === "" ? "" : ` (${event.filename}:${event.lineno})`}`);
	});

	worker.addEventListener("messageerror", () => {
		fail("a message couldn't be read");
	});
}
