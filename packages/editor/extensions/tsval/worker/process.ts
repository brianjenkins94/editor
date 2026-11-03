/**
 * The program's process, as a terminal's run has it: its stdin (what's typed there), the servers it listens with, what
 * holds it open, and its exit.
 */
import type { Control } from "../debug-protocol";
import { state } from "./state";

/** The ports a debug run's servers listen on (node:http, from almostnode): each answers the preview (`virtual.debug.<port>`,
 *  asked by the dev-server worker) and keeps the run alive — out of work, it idles, serving. */
export const listening = new Set<number>();

/** The program's process.stdin: what's typed in the Debug Console arrives on it (`stdin` control) — a `data` event, a
 *  string — and a program listening on it is kept alive, waiting for input, as by a server. */
export const stdin = ((): { "on": (event: string, listener: (...args: unknown[]) => void) => unknown; "emit": (event: string, ...args: unknown[]) => boolean; "listenerCount": (event: string) => number } => {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const self = {
		"isTTY": false,
		"on": (event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, [...listeners.get(event) ?? [], listener]);

			return self;
		},
		"addListener": (event: string, listener: (...args: unknown[]) => void) => self.on(event, listener),
		"once": (event: string, listener: (...args: unknown[]) => void) => {
			const once = (...args: unknown[]): void => {
				self.off(event, once);
				listener(...args);
			};

			return self.on(event, once);
		},
		"off": (event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, (listeners.get(event) ?? []).filter((each) => each !== listener));

			return self;
		},
		"removeListener": (event: string, listener: (...args: unknown[]) => void) => self.off(event, listener),
		"removeAllListeners": (event?: string) => {
			if (event === undefined) {
				listeners.clear();
			} else {
				listeners.delete(event);
			}

			return self;
		},
		"emit": (event: string, ...args: unknown[]) => {
			const each = listeners.get(event) ?? [];

			each.forEach((listener) => {
				listener(...args);
			});

			return each.length > 0;
		},
		"listenerCount": (event: string) => listeners.get(event)?.length ?? 0,
		"setEncoding": () => self,
		"resume": () => self,
		"pause": () => self,
		"setRawMode": () => self
	};

	return self;
})();

/**
 * A debugged tsval run gets the SAME zero-authority capability surface the canary uses (shared `capabilityStandins`):
 * `fetch` and node builtins (`node:fs`, `node:child_process`, …) resolve to inert, effect-free stand-ins, and any
 * OTHER import resolves to a recursive inert proxy. Without this the guest crashes on the first `import` of a node
 * builtin (there is no real module system in the worker) BEFORE reaching a capability breakpoint — the whole point of
 * the hard-stop. Real effects belong to the almostnode "production" adapter, not to tsval's reverse-steppable VM.
 */
/** `process.exit(code)` out of the program (capabilitySurface): the run ends there with `code`, as node's does — not a
 *  crash. Caught where a run's end is decided. */
export const EXITED = Symbol("process.exit");

/** Whether the program waits on its stdin. */
export const readsStdin = (): boolean => stdin.listenerCount("data") + stdin.listenerCount("readable") > 0;

/** What holds a debug run open — almostnode's keep-alive hook (`__nodeKeepAlive`): a server is held from the moment
 *  it's told to listen (its port is known a microtask later), let go when it closes or is unref'd. */
export const held = new Set<unknown>();

Object.assign(globalThis, { "__nodeKeepAlive": {
	"retain": (handle: unknown) => { held.add(handle); },
	"release": (handle: unknown) => { held.delete(handle); }
} });

/** Typed in the Debug Console or the terminal it was started in: the program's input — its listeners called with it
 *  (or, at its end, told so), and the run woken to go on. */
export function typed(message: Extract<Control, { "type": "stdin" }>): void {
	if (message.end === true) {
		stdin.emit("end");
	} else {
		stdin.emit("data", message.data);
	}

	state.current?.loop?.wake?.();
}
