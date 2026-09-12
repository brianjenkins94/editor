#!/usr/bin/env node
/**
 * dev-hub entry — starts the WebSocket collector and serves the MCP tools over stdio.
 *
 * The browser (the editor's rootHub) connects to `ws://localhost:<port>/`; an MCP client (Claude Code) spawns
 * this process and speaks MCP over stdio. Because MCP owns stdout, ALL diagnostics here go to stderr — a single
 * stray stdout write would corrupt the JSON-RPC stream. Port: --port <n> or DEV_HUB_PORT, default 7378.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDevHub } from "./server.ts";
import { createMcpServer } from "./mcp.ts";

function resolvePort(): number {
	const flagIndex = process.argv.indexOf("--port");
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
	const raw = fromFlag ?? process.env["DEV_HUB_PORT"];
	const port = raw === undefined ? NaN : Number(raw);

	return Number.isFinite(port) ? port : 7378;
}

async function main(): Promise<void> {
	const port = resolvePort();
	const devHub = createDevHub({ "port": port });

	console.error(`[dev-hub] WebSocket collector listening on ws://localhost:${port}`);

	const mcp = createMcpServer(devHub);

	await mcp.connect(new StdioServerTransport());
	console.error("[dev-hub] MCP server ready on stdio");

	const shutdown = (): void => {
		void devHub.close().then(() => process.exit(0));
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
	console.error("[dev-hub] fatal:", error);
	process.exit(1);
});
