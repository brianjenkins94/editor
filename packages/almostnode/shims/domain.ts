/**
 * What almostnode's `domain` has over unenv's (builtins.ts): a Domain that runs what it's given (unenv's only says it
 * isn't implemented), and `create` making one. The module is deprecated, but some packages still use it.
 */

import { EventEmitter } from "unenv/node/events";

export class Domain extends EventEmitter {
	members: unknown[] = [];

	add(emitter: EventEmitter): void {
		this.members.push(emitter);
	}

	remove(emitter: EventEmitter): void {
		const index = this.members.indexOf(emitter);

		if (index !== -1) {
			this.members.splice(index, 1);
		}
	}

	bind<T extends (...args: unknown[]) => unknown>(callback: T): T {
		return callback;
	}

	intercept<T extends (...args: unknown[]) => unknown>(callback: T): T {
		return callback;
	}

	run<T>(fn: () => T): T {
		return fn();
	}

	dispose(): void {
		this.members = [];
	}

	enter(): void {
    // Stub
	}

	exit(): void {
    // Stub
	}
}

export function create(): Domain {
	return new Domain();
}
