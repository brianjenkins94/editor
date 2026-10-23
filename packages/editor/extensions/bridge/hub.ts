/**
 * The bridge hub — the bridge extension's own message hub (see @brianjenkins94/hub).
 *
 * It's the root of the extension's subtree: the ext host owns it, each worker links UP to it, and it works
 * entirely standalone (no harness required). When a harness is present, the workbench links this bridge hub up to
 * the page's root hub, so a subject the page cares about (render output, logs) federates outward — but the bridge
 * never depends on that link existing. This is the clean extension/harness boundary: the bridge speaks hub
 * subjects and degrades to a standalone root when nothing is above it.
 */
import type { WorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import { linkRuntime } from "@brianjenkins94/editor-api/runtime";
import { createHub } from "@brianjenkins94/hub";

export const bridgeHub = createHub({ "id": "bridge" });

/** The shared workspace (zen-fs's SharedArrayBuffer), once the workbench hands it over: what the bridge's workers mount at
 *  /workspace — an LSP server's through its control port, a debug run's in its launch. */
export const workspace: { "buffer"?: SharedArrayBuffer } = {};

/** The workspace runtime, for any debugger in this extension host (ARCHITECTURE.md, *Extension points* 2; editor-api's
 *  `WorkspaceRuntime`): the workspace's buffer as it is when asked for, and a port into the bridge hub per worker — linked
 *  as every runtime link is (editor-api's `linkRuntime`), and connected with its `connectRuntime`. */
export function workspaceRuntime(): WorkspaceRuntime {
	return {
		get "buffer"() { return workspace.buffer; },
		"connect": (name, session) => {
			const channel = new MessageChannel();
			const unlink = linkRuntime(bridgeHub, channel.port1, name, session);

			return {
				"port": channel.port2,
				"dispose": () => {
					unlink();
					channel.port1.close();
				}
			};
		}
	};
}
