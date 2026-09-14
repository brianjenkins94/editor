/**
 * inspector shim - V8 inspector is not available in browser
 */

import { EventEmitter } from "./events";

export class Session extends EventEmitter {
	connect(): void {}
	connectToMainThread(): void {}
	disconnect(): void {}
	post(_method: string, _params?: object, _callback?: (err: Error | null, result?: object) => void): void {
		if (_callback) { setTimeout(_callback, 0, null, {}); }
	}
}

export function open(_port?: number, _host?: string, _wait?: boolean): void {}
export function close(): void {}
export function url(): string | undefined { return undefined; }
export function waitForDebugger(): void {}

export const { console } = globalThis;

export default {
	"Session": Session,
	"open": open,
	"close": close,
	"url": url,
	"waitForDebugger": waitForDebugger,
	"console": console
};
