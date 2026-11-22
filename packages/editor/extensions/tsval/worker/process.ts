import type { Control } from "../debug-protocol";
import { state } from "./state";

export const listening = new Set<number>();

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

export const EXITED = Symbol("process.exit");

export const readsStdin = (): boolean => stdin.listenerCount("data") + stdin.listenerCount("readable") > 0;

export const held = new Set<unknown>();

Object.assign(globalThis, { "__nodeKeepAlive": {
	"retain": (handle: unknown) => { held.add(handle); },
	"release": (handle: unknown) => { held.delete(handle); }
} });

export function typed(message: Extract<Control, { "type": "stdin" }>): void {
	if (message.end === true) {
		stdin.emit("end");
	} else {
		stdin.emit("data", message.data);
	}

	state.current?.loop?.wake?.();
}
