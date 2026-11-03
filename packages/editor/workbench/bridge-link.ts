import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { failureText } from "@brianjenkins94/editor-api/failures";

/** What the bridge exports for this link (the bridge extension's BridgeExports, as far as the link reads it: a realm
 *  doesn't import an extension's code). */
interface BridgeLink {
	"toWorkbench": vscodeApi.Event<unknown>;
	"fromWorkbench": (message: unknown) => void;
	"attachWorkspaceBuffer"?: (buffer: unknown) => void;
}

/**
 * Uplink the extension bridge's hub to the page's root hub. The ext host is an isolated `extension-file://` realm
 * with no window path out, so the bridge rides the bridge extension's EXPORTED bridge (a marshaled event +
 * function, see extensions/bridge/extension.ts' BridgeExports). A workbench hub links that bridge to the bridge and windowTransport(host)
 * to the top page (workbench-entry HAS window access) — so bridge/worker spans reach the page's $sys.log.>
 * collector. No-op if the extension exposes no bridge (the bridge then stays a standalone root).
 */
export function wireWorkbenchHub(vscode: typeof vscodeApi, hub: Hub, log: Logger, workspaceBuffer?: SharedArrayBuffer): void {
	const bridge = vscode.extensions.getExtension("brianjenkins94.bridge");

	if (bridge === undefined) {
		return;
	}

	(bridge.activate() as Promise<BridgeLink | undefined>).then((bridge) => {
		if (bridge?.toWorkbench === undefined || bridge.fromWorkbench === undefined) {
			return;
		}

		// Hand the bridge the shared workspace SharedArrayBuffer: a debug run's worker mounts the SAME zen-fs the editor uses
		// (at /workspace), through the workspace runtime. No-op when there's no SAB (no cross-origin isolation).
		if (workspaceBuffer !== undefined) {
			bridge.attachWorkspaceBuffer?.(workspaceBuffer);
		}

		// bridge (ext host) <-> workbench, over the extension's exported event/function bridge. (The workbench <->
		// top-page link is the transferred MessagePort wired above.)
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
