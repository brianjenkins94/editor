/**
 * debug-mcp entry — starts the WebSocket collector and serves the MCP tools over stdio.
 *
 * The browser (the editor's rootHub) connects to `ws://localhost:<port>/`; an MCP client (Claude Code) spawns
 * this process and speaks MCP over stdio. Because MCP owns stdout, ALL diagnostics here go to stderr — a single
 * stray stdout write would corrupt the JSON-RPC stream. Port: --port <n> or DEV_HUB_PORT, default 7378. A second agent
 * session's finds the port taken and goes through the one that has it (relay.ts).
 */
import type { Relay } from "./relay.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./mcp.ts";
import { portOf, relay } from "./relay.ts";

function resolvePort(): number {
	const flagIndex = process.argv.indexOf("--port");
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
	const raw = fromFlag ?? process.env["DEV_HUB_PORT"];
	const port = raw === undefined ? NaN : Number(raw);

	return Number.isFinite(port) ? port : 7378;
}

async function main(): Promise<void> {
	const port = portOf(resolvePort());
	const stdio = new StdioServerTransport();
	// The port, or — another agent session's debug-mcp has it — that one's MCP, relayed (relay.ts), taking the port when it goes.
	const debugMcp = await port.take();
	let relayed: Relay | undefined;

	if (debugMcp === undefined) {
		console.error(`[debug-mcp] port ${String(resolvePort())} is taken: this session's MCP goes through what holds it`);
		relayed = await relay(stdio, port.connect);
	} else {
		console.error(`[debug-mcp] WebSocket collector listening on ws://localhost:${String(resolvePort())}`);
		await createMcpServer(debugMcp).connect(debugMcp.agent.observe(stdio));
		console.error("[debug-mcp] MCP server ready on stdio");
	}

	let closing = false;
	const shutdown = (): void => {
		if (closing) {
			return;
		}

		closing = true;
		// Hard stop after a beat so a hung close() (e.g. a socket that won't finish closing) can't leave us holding
		// the port — the exact orphan this teardown exists to prevent. unref so it never keeps us alive on its own.
		setTimeout(() => process.exit(0), 1000).unref();
		// (a relay's session ended at its upstream too, and the port let go if this one took it meanwhile)
		void Promise.all([relayed?.close(), port.owned()?.close()]).then(() => process.exit(0));
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// The MCP client (our stdio parent) doesn't always signal on the way out — it can just close the pipe. Without
	// this the process kept running and kept the WS port bound, so the NEXT debug-mcp couldn't bind (EADDRINUSE)
	// and every reconnect died until the orphan was killed by hand. Exit when the client's half of the stdio
	// channel ends/closes, so the port is freed the instant the client disconnects. (Do NOT override
	// transport.onclose — the MCP SDK owns that for its own teardown; observing stdin is independent of it.)
	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);
}

void main().catch((error: unknown) => {
	console.error("[debug-mcp] fatal:", error);
	process.exit(1);
});
