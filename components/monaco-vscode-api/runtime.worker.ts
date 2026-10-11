/// <reference lib="webworker" />
/**
 * The editor's workspace runtime in a worker core boots — for the web worker extension host's extensions, whose
 * debuggers reach the editor this way (EXTENSION-POINTS.md, 2): VS Code takes `postMessage` away from them, so each
 * debugger's port into the editor goes up core's port (architecture/workerPort.ts), linked into the workbench's hub by
 * whoever holds it (installMonacoProbes' `linkRuntime`, the extension host's only). Put where run-contract's
 * `workspaceRuntime()` looks for it (its `RUNTIME` symbol). No buffer: the workspace's own bytes are for the editor's
 * own debugger.
 */
import type { ProbeMessage } from "./architecture/protocol";
import { toCore } from "./architecture/workerPort";

declare const self: DedicatedWorkerGlobalScope;

(self as unknown as Record<symbol, unknown>)[Symbol.for("@brianjenkins94/run-contract/workspaceRuntime")] = {
	"buffer": undefined,
	"connect": (name: string, session?: string) => {
		const link = new MessageChannel();
		const id = crypto.randomUUID();

		toCore([{ "type": "runtime", "id": id, "name": name, ...session === undefined ? {} : { "session": session }, "port": link.port1 }] satisfies ProbeMessage[], [link.port1]);

		return { "port": link.port2, "dispose": () => { toCore([{ "type": "runtime-close", "id": id }] satisfies ProbeMessage[]); link.port2.close(); } };
	}
};
