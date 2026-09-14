/**
 * Main-thread side of the terminal's node runner: spawns the node-worker (extensions/worker-pod/node-worker.ts),
 * hands it the shared workspace SharedArrayBuffer so it runs on the SAME zen-fs, federates its hub into the
 * workbench hub (one link carries both the `node.run` dispatch and the worker's observability spans up to the
 * page collector), and returns a `runNode` the terminal's `node` command calls. See terminal-node.ts.
 */
import { createRpcClient, portTransport } from "@brianjenkins94/hub";
import type { Hub } from "@brianjenkins94/hub";

export type RunNode = (file: string, cwd: string, env: Record<string, string>) => Promise<{ "stdout": string; "stderr": string; "exitCode": number }>;

/** Spawn the node worker, wire it into `hub`, and return a function that runs a script in it via `node.run`. */
export function createNodeRunner(hub: Hub, workspaceBuffer?: SharedArrayBuffer): RunNode {
	const worker = new Worker(new URL("./lsp/node-worker.js", location.href), { "type": "module" });

	// Hand the worker the shared workspace SAB over a dedicated control port (mirrors the pod), so it mounts the
	// SAME zen-fs at /workspace. Without a buffer (no cross-origin isolation) it runs on its own InMemory root.
	const channel = new MessageChannel();

	worker.postMessage({ "type": "ws-control" }, [channel.port2]);

	if (workspaceBuffer !== undefined) {
		channel.port1.postMessage({ "buffer": workspaceBuffer });
	}

	// Federate the worker's hub into the workbench hub — dispatch (the RPC) and observability (its spans) ride
	// the one link. Dispatch works immediately; the spans reach the page collector once the workbench uplink is up.
	hub.link(portTransport(worker));
	const rpc = createRpcClient(hub);

	return (file, cwd, env) => rpc.request("node.run", { "file": file, "cwd": cwd, "env": env }, { "timeoutMs": 120000 }) as ReturnType<RunNode>;
}
