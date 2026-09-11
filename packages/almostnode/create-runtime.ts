/**
 * Runtime Factory — vendored/trimmed to the same-origin, main-thread path only.
 *
 * Upstream also offered `WorkerRuntime` (comlink-based nested worker) and `SandboxRuntime` (cross-origin
 * iframe). The editor runs its language servers on the main thread of a plain worker with
 * `dangerouslyAllowSameOrigin: true`, so those branches — and their deps (comlink) — are removed here. If a
 * worker/sandbox runtime is ever needed again, restore worker-runtime.ts / sandbox-runtime.ts from upstream.
 */

import { Runtime } from "./runtime";
import type { VirtualFS } from "./virtual-fs";
import type { IRuntime, IExecuteResult, CreateRuntimeOptions, IRuntimeOptions } from "./runtime-interface";

/**
 * Wrapper that makes the synchronous Runtime conform to the async IRuntime interface
 */
class AsyncRuntimeWrapper implements IRuntime {
	private runtime: Runtime;

	constructor(vfs: VirtualFS, options: IRuntimeOptions = {}) {
		this.runtime = new Runtime(vfs, options);
	}

	async execute(code: string, filename?: string): Promise<IExecuteResult> {
		return Promise.resolve(this.runtime.execute(code, filename));
	}

	async runFile(filename: string): Promise<IExecuteResult> {
		return Promise.resolve(this.runtime.runFile(filename));
	}

	clearCache(): void {
		this.runtime.clearCache();
	}

	getVFS(): VirtualFS {
		return this.runtime.getVFS();
	}

	/**
	 * Get the underlying sync Runtime for direct access to sync methods
	 */
	getSyncRuntime(): Runtime {
		return this.runtime;
	}
}

/**
 * Create a same-origin, main-thread runtime instance.
 *
 * SECURITY: Same-origin execution requires explicit `dangerouslyAllowSameOrigin` opt-in, because executed
 * code can access cookies, localStorage, and IndexedDB. Only use it for trusted code (e.g. our own bundled
 * language servers).
 *
 * @param vfs - Virtual file system instance
 * @param options - Runtime options including the same-origin opt-in
 * @returns Promise resolving to an IRuntime instance
 * @throws Error if dangerouslyAllowSameOrigin is not specified
 */
export async function createRuntime(
	vfs: VirtualFS,
	options: CreateRuntimeOptions = {}
): Promise<IRuntime> {
	const { dangerouslyAllowSameOrigin, ...runtimeOptions } = options;

	if (!dangerouslyAllowSameOrigin) {
		throw new Error(
			"almostnode: Same-origin execution requires explicit opt-in: { dangerouslyAllowSameOrigin: true }\n" +
			"Same-origin execution allows code to access cookies, localStorage, and IndexedDB.\n" +
			"Only use dangerouslyAllowSameOrigin for trusted code."
		);
	}

	return new AsyncRuntimeWrapper(vfs, runtimeOptions);
}

// Re-export types and classes for convenience
export { Runtime } from "./runtime";
export type {
	IRuntime,
	IExecuteResult,
	IRuntimeOptions,
	CreateRuntimeOptions,
	VFSSnapshot,
} from "./runtime-interface";
