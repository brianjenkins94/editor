/**
 * Timer keep-alive ref-counting for the node worker (node-worker.ts).
 *
 * almostnode's `runFile` is synchronous — it returns when the script's top-level body finishes, but real Node
 * keeps the process alive until nothing is left on the event loop. To emulate that "is it done?" signal in the
 * browser we OWN the worker's timers and ref-count them: a pending `setTimeout` and a live `setInterval` each
 * keep the process alive; a fired timeout or a cleared timer releases it. When the count drains to zero (and no
 * stdin reader is attached — that check lives in the worker), the run is quiescent and we publish its exit.
 *
 * We install BEFORE almostnode's Runtime so its own timer patch (guarded by a `__patched` flag it also sets)
 * finds ours already in place and leaves it — meaning every timer the script schedules flows through this
 * counter. Timers still return Node-compatible objects (`ref`/`unref`/`hasRef`/`refresh`, coercible to the id),
 * so packages that poke at them keep working.
 */

interface Token { "realId": ReturnType<typeof setTimeout>; "interval": boolean }

/** Node-compatible timer handle — coerces to its numeric id and answers the ref/unref poking libraries do. */
interface NodeTimer { "_id": unknown; "__ka": Token; "ref": () => NodeTimer; "unref": () => NodeTimer; "hasRef": () => boolean; "refresh": () => NodeTimer; [Symbol.toPrimitive]: () => unknown }

export interface TimerKeepAlive {
	/** Arm a fresh run. `stdinIsListening` reports whether the running process still has a stdin reader attached. */
	"begin": (stdinIsListening: () => boolean) => void;
	/** After the synchronous body returns, call `cb` once the event loop has drained (or immediately if already so). */
	"whenQuiescent": (cb: () => void) => void;
	/** End the run: cancel any leftover script timers and forget the session (also disarms their callbacks). */
	"reset": () => void;
}

/** Patch the worker's global timers with keep-alive counting (idempotent) and return the run controller. */
export function installTimerKeepAlive(): TimerKeepAlive {
	const globals = globalThis as unknown as {
		"setTimeout": typeof setTimeout & { "__keepAlive"?: TimerKeepAlive; "__patched"?: boolean };
		"setInterval": typeof setInterval & { "__patched"?: boolean };
		"clearTimeout": typeof clearTimeout;
		"clearInterval": typeof clearInterval;
	};

	if (globals.setTimeout.__keepAlive !== undefined) {
		return globals.setTimeout.__keepAlive; // already installed on this worker
	}

	const realSetTimeout = globalThis.setTimeout.bind(globalThis);
	const realSetInterval = globalThis.setInterval.bind(globalThis);
	const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
	const realClearInterval = globalThis.clearInterval.bind(globalThis);

	const active = new Set<Token>();
	// Non-timer keep-alive handles (a listening server, etc.) that hold the process open like a ref'd libuv handle.
	// Fed by the global hook below, which almostnode's net/http shim calls on listen/close/ref/unref.
	const handles = new Set<object>();
	let stdinIsListening: (() => boolean) | undefined;
	let quiescentCb: (() => void) | undefined;
	let checkScheduled = false;

	// Let microtasks (awaited sync work) flush on a real macrotask tick, then declare quiescence if nothing keeps
	// the loop alive. Guarded so many releases collapse into one check; the worker's `finish` is itself idempotent.
	const scheduleCheck = (): void => {
		if (quiescentCb === undefined || checkScheduled) {
			return;
		}

		checkScheduled = true;
		realSetTimeout(() => {
			checkScheduled = false;

			if (quiescentCb !== undefined && active.size === 0 && handles.size === 0 && !(stdinIsListening?.() ?? false)) {
				const cb = quiescentCb;

				quiescentCb = undefined;
				cb();
			}
		}, 0);
	};

	const release = (token: Token): void => {
		if (active.delete(token)) {
			scheduleCheck();
		}
	};

	const makeTimer = (token: Token): NodeTimer => {
		const timer: NodeTimer = {
			"_id": token.realId,
			"__ka": token,
			"ref": () => timer,
			"unref": () => timer,
			"hasRef": () => true,
			"refresh": () => timer,
			[Symbol.toPrimitive]: () => token.realId
		};

		return timer;
	};

	globals.setTimeout = Object.assign((handler: TimerHandler, timeout?: number, ...rest: unknown[]): NodeTimer => {
		const token = { "realId": 0 as unknown as ReturnType<typeof setTimeout>, "interval": false };

		active.add(token);
		token.realId = realSetTimeout((...cbArgs: unknown[]) => {
			if (!active.delete(token)) {
				return; // cleared or reset before it fired
			}

			try {
				if (typeof handler === "function") {
					(handler as (...handlerArgs: unknown[]) => void)(...cbArgs);
				}
			} finally {
				scheduleCheck(); // this timeout is done — the loop may now be idle
			}
		}, timeout, ...rest);

		return makeTimer(token);
	}, { "__patched": true, "__keepAlive": undefined }) as typeof globals.setTimeout;

	globals.setInterval = Object.assign((handler: TimerHandler, timeout?: number, ...rest: unknown[]): NodeTimer => {
		const token = { "realId": 0 as unknown as ReturnType<typeof setTimeout>, "interval": true };

		active.add(token); // an interval keeps the loop alive until it is cleared
		token.realId = realSetInterval((...cbArgs: unknown[]) => {
			if (active.has(token) && typeof handler === "function") {
				(handler as (...handlerArgs: unknown[]) => void)(...cbArgs);
			}
		}, timeout, ...rest);

		return makeTimer(token);
	}, { "__patched": true }) as typeof globals.setInterval;

	globals.clearTimeout = (handle?: unknown): void => {
		const token = (handle as NodeTimer | undefined)?.__ka;

		if (token !== undefined) {
			realClearTimeout(token.realId);
			release(token);
		} else {
			realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
		}
	};

	globals.clearInterval = (handle?: unknown): void => {
		const token = (handle as NodeTimer | undefined)?.__ka;

		if (token !== undefined) {
			realClearInterval(token.realId);
			release(token);
		} else {
			realClearInterval(handle as Parameters<typeof clearInterval>[0]);
		}
	};

	const clearActive = (): void => {
		for (const token of active) {
			if (token.interval) {
				realClearInterval(token.realId);
			} else {
				realClearTimeout(token.realId);
			}
		}

		active.clear();
		handles.clear();
	};

	// Global hook almostnode's net/http shim calls to keep the process alive while a server is listening. Guarded
	// by optional chaining at the call site, so it's a no-op in workers that never install keep-alive.
	(globalThis as unknown as { "__nodeKeepAlive"?: { "retain": (handle: object) => void; "release": (handle: object) => void } }).__nodeKeepAlive = {
		"retain": (handle) => { handles.add(handle); },
		"release": (handle) => {
			if (handles.delete(handle)) {
				scheduleCheck();
			}
		}
	};

	const controller: TimerKeepAlive = {
		"begin": (listening) => {
			clearActive(); // start from a clean slate (e.g. drop the boot `node.ready` announcer timers)
			stdinIsListening = listening;
			quiescentCb = undefined;
			checkScheduled = false;
		},
		"whenQuiescent": (cb) => {
			quiescentCb = cb;
			scheduleCheck(); // a one-shot script with no pending timers is already done
		},
		"reset": () => {
			clearActive();
			stdinIsListening = undefined;
			quiescentCb = undefined;
			checkScheduled = false;
		}
	};

	globals.setTimeout.__keepAlive = controller;

	return controller;
}
