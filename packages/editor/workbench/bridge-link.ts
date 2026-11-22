import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { failureText } from "@brianjenkins94/editor-api/failures";

interface BridgeLink {
	"toWorkbench": vscodeApi.Event<unknown>;
	"fromWorkbench": (message: unknown) => void;
	"attachWorkspaceBuffer"?: (buffer: unknown) => void;
}

export function wireWorkbenchHub(vscode: typeof vscodeApi, hub: Hub, log: Logger, workspaceBuffer?: SharedArrayBuffer): void {
	const bridge = vscode.extensions.getExtension("brianjenkins94.bridge");

	if (bridge === undefined) {
		return;
	}

	(bridge.activate() as Promise<BridgeLink | undefined>).then((bridge) => {
		if (bridge?.toWorkbench === undefined || bridge.fromWorkbench === undefined) {
			return;
		}

		if (workspaceBuffer !== undefined) {
			bridge.attachWorkspaceBuffer?.(workspaceBuffer);
		}

		hub.link({
			"send": (message) => { bridge.fromWorkbench(message); },
			"listen": (onMessage) => {
				const subscription = bridge.toWorkbench(onMessage);

				return () => {
					subscription.dispose();
				};
			}
		});
	}).catch((error: unknown) => { log.error("workbench hub uplink failed", { "error": failureText(error) }); });
}
