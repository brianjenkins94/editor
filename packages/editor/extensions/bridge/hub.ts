import type { WorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import { linkRuntime } from "@brianjenkins94/editor-api/runtime";
import { createHub } from "@brianjenkins94/hub";

export const bridgeHub = createHub({ "id": "bridge" });

export const workspace: { "buffer"?: SharedArrayBuffer } = {};

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
