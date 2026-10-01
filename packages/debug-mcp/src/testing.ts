/**
 * For tests of code that runs against a debug-mcp (this package's, and an app's own — netsim's browser tests): an MCP
 * client wired to a debug-mcp in memory, with `call` returning a tool's result parsed.
 */
import type { DebugMcp } from "./server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.ts";

export interface TestClient {
	"client": Client;
	/** Call tool `name`: its result's text, as JSON when it parses (else the text), and whether it's an error. */
	"call": (name: string, args?: Record<string, unknown>) => Promise<{ "isError"?: boolean; "value": unknown }>;
	"close": () => Promise<void>;
}

export async function connectTestClient(debugMcp: DebugMcp): Promise<TestClient> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ "name": "test", "version": "0.0.0" });

	await createMcpServer(debugMcp).connect(serverSide);
	await client.connect(clientSide);

	return {
		"client": client,
		"call": async (name, args = {}) => {
			const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "text"?: string }[] };
			const text = result.content[0]?.text ?? "";
			let value: unknown = text;

			try {
				value = JSON.parse(text);
			} catch { /* not JSON: the text itself */ }

			return { "isError": result.isError, "value": value };
		},
		"close": async () => { await client.close(); }
	};
}
