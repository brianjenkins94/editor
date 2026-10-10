/**
 * The pod hub — the worker-pod extension's own message hub (see @brianjenkins94/hub).
 *
 * It's the root of the extension's subtree: the ext host owns it, each worker links UP to it, and it works
 * entirely standalone (no harness required). When a harness is present, the workbench links this pod hub up to
 * the page's root hub, so a subject the page cares about (render output, logs) federates outward — but the pod
 * never depends on that link existing. This is the clean extension/harness boundary: the pod speaks hub
 * subjects and degrades to a standalone root when nothing is above it.
 */
import type { WorkspaceRuntime } from "@brianjenkins94/run-contract/runtime";
import { createHub, portTransport } from "@brianjenkins94/hub";

export const podHub = createHub({ "id": "pod" });

/** The shared workspace (zen-fs's SharedArrayBuffer), once the workbench hands it over: what the pod's workers mount at
 *  /workspace — an LSP server's through its control port, a debug run's in its launch. */
export const workspace: { "buffer"?: SharedArrayBuffer } = {};

/** The workspace runtime, for any debugger (EXTENSION-POINTS.md, 2; run-contract's `WorkspaceRuntime`): the workspace's
 *  buffer as it is when asked for, and a port into the pod hub per worker — which connects with run-contract's
 *  `connectRuntime`. worker-pod exports it (extension.ts) for another extension's debugger. */
export function workspaceRuntime(): WorkspaceRuntime {
	return {
		get "buffer"() { return workspace.buffer; },
		"connect": () => {
			const channel = new MessageChannel();
			const unlink = podHub.link(portTransport(channel.port1));

			return { "port": channel.port2, "dispose": () => { unlink(); channel.port1.close(); } };
		}
	};
}
