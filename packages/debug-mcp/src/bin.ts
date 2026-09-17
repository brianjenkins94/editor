#!/usr/bin/env node
/**
 * debug-mcp entry — starts the WebSocket collector and serves the MCP tools over stdio.
 *
 * The browser (the editor's rootHub) connects to `ws://localhost:<port>/`; an MCP client (Claude Code) spawns
 * this process and speaks MCP over stdio. Because MCP owns stdout, ALL diagnostics here go to stderr — a single
 * stray stdout write would corrupt the JSON-RPC stream. Port: --port <n> or DEV_HUB_PORT, default 7378.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./mcp.ts";
import { createDebugMcp } from "./server.ts";

function resolvePort(): number {
	const flagIndex = process.argv.indexOf("--port");
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
	const raw = fromFlag ?? process.env["DEV_HUB_PORT"];
	const port = raw === undefined ? NaN : Number(raw);

	return Number.isFinite(port) ? port : 7378;
}

async function main(): Promise<void> {
	const port = resolvePort();
	const debugMcp = createDebugMcp({ "port": port });

	// Wait for the socket to actually bind before announcing it — rejects on EADDRINUSE etc. (handled below),
	// instead of the old unhandled 'error' that crashed the process on a port collision.
	await debugMcp.whenListening;

	console.error(`[debug-mcp] WebSocket collector listening on ws://localhost:${port}`);

	const mcp = createMcpServer(debugMcp);

	await mcp.connect(new StdioServerTransport());
	console.error("[debug-mcp] MCP server ready on stdio");

	let closing = false;
	const shutdown = (): void => {
		if (closing) {
			return;
		}

		closing = true;
		// Hard stop after a beat so a hung close() (e.g. a socket that won't finish closing) can't leave us holding
		// the port — the exact orphan this teardown exists to prevent. unref so it never keeps us alive on its own.
		setTimeout(() => process.exit(0), 1000).unref();
		void debugMcp.close().then(() => process.exit(0));
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
	if ((error as { "code"?: string } | undefined)?.code === "EADDRINUSE") {
		console.error(`[debug-mcp] port ${resolvePort()} already in use — another debug-mcp is likely running. Exiting.`);
	} else {
		console.error("[debug-mcp] fatal:", error);
	}

	process.exit(1);
});
