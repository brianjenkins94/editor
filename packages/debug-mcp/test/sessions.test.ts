// A second agent session, through the debug-mcp that holds the port (src/sessions.ts, src/relay.ts).
import type { AddressInfo } from "node:net";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { portOf, relay } from "../src/relay.ts";
import { createDebugMcp } from "../src/server.ts";

// (the tools' use these tests make kept nowhere: a test's calls aren't an agent's — relay.ts `usageFile`)
process.env["DEBUG_MCP_USAGE_FILE"] = "none";

/** A client whose session is relayed by a debug-mcp that finds `port` taken (bin.ts's second session). */
async function relayedClient(port: number) {
	const [ours, theirs] = InMemoryTransport.createLinkedPair();
	const ported = portOf(port);
	const relayed = await relay(theirs, ported.connect, () => {});
	const client = new Client({ "name": "test", "version": "0.0.0" });

	await client.connect(ours);

	return {
		"client": client,
		"ported": ported,
		"close": async () => { await client.close(); await relayed.close(); await ported.owned()?.close(); }
	};
}

const names = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((tool) => tool.name);

test("another session's MCP is served over HTTP, from this machine only", async () => {
	const debugMcp = createDebugMcp({ "port": 0 });
	const port = await debugMcp.whenListening;

	try {
		const client = new Client({ "name": "test", "version": "0.0.0" });

		await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${String(port)}/mcp`)));
		assert.ok((await names(client)).includes("logs_query"));
		assert.equal(debugMcp.sessions(), 1);

		// (a page — it sends an Origin — never)
		const fromPage = await fetch(`http://localhost:${String(port)}/mcp`, {
			"method": "POST",
			"headers": { "origin": "http://localhost:5173", "content-type": "application/json" },
			"body": "{}"
		});

		assert.equal(fromPage.status, 403);
		await client.close();
	} finally {
		await debugMcp.close();
	}
});

test("a session whose port is taken relays to the debug-mcp there, and takes the port when it goes", async () => {
	const first = createDebugMcp({ "port": 0 });
	const port = await first.whenListening;
	const second = await relayedClient(port);
	let changed = 0;

	second.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed += 1; });

	try {
		assert.ok((await names(second.client)).includes("logs_query"));
		assert.equal(first.sessions(), 1);
		assert.equal(second.ported.owned(), undefined);

		// (the first session ends: its debug-mcp lets the port go)
		await first.close();

		const answer = await second.client.callTool({ "name": "tree_state", "arguments": {} });

		assert.notEqual(answer.isError, true);
		assert.ok(second.ported.owned() !== undefined, "it took the port");
		assert.ok(changed >= 1, "its client was told the tools may have changed");
	} finally {
		await second.close();
	}
});

test("a port another program holds is said in the session's instructions", async () => {
	const other = createServer((_request, response) => { response.writeHead(404).end("not here"); });

	await new Promise<void>((resolve) => { other.listen(0, resolve); });

	const { port } = other.address() as AddressInfo;
	const session = await relayedClient(port);

	try {
		assert.match(session.client.getInstructions() ?? "", new RegExp(`port ${String(port)} is held by a program that isn't a debug-mcp`, "u"));
		assert.equal(session.ported.owned(), undefined);
	} finally {
		await session.close();
		other.close();
	}
});
