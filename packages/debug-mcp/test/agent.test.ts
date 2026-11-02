// The agent's tool use, observable (src/agent.ts): the editor's tools spanned at the transport, the rest as a hook reports them.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createDebugMcp } from "../src/server.ts";

/** A transport whose incoming messages the test sends, and whose sent ones it keeps. */
function fakeTransport(): Transport & { "receive": (message: JSONRPCMessage) => void; "sent": JSONRPCMessage[] } {
	const sent: JSONRPCMessage[] = [];
	const transport: Transport & { "receive": (message: JSONRPCMessage) => void; "sent": JSONRPCMessage[] } = {
		"sent": sent,
		"start": async () => {},
		"close": async () => {},
		"send": async (message) => { sent.push(message); },
		"receive": (message) => { transport.onmessage?.(message); }
	};

	return transport;
}

test("an editor tool's call is a span on the agent source, a failed one an error", async () => {
	const debugMcp = createDebugMcp({ "port": 0 });

	try {
		await debugMcp.whenListening;

		const inner = fakeTransport();
		const outer = debugMcp.agent.observe(inner);

		outer.onmessage = () => {};
		inner.receive({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "files_read", "arguments": { "path": "a.ts", "tab": "t1" } } });
		await outer.send({ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "x".repeat(500) }] } });
		inner.receive({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "git_push", "arguments": {} } });
		await outer.send({ "jsonrpc": "2.0", "id": 2, "result": { "isError": true, "content": [{ "type": "text", "text": "HTTP Error: 403" }] } });

		const spans = debugMcp.store.querySpans({ "source": "agent" });

		assert.deepEqual(spans.map((span) => [span.attrs?.["tool"], span.attrs?.["via"], span.attrs?.["tab"]]), [["files_read", "editor", "t1"], ["git_push", "editor", undefined]]);
		assert.ok(spans.every((span) => span.open !== true));
		assert.equal(inner.sent.length, 2);
		assert.equal(debugMcp.store.queryLogs({ "source": "agent", "minLevel": "error" }).map((record) => record.attrs?.["message"])[0], "HTTP Error: 403");
	} finally {
		await debugMcp.close();
	}
});

test("a hook's report of a tool around the editor is a span, from a program and never a page", async () => {
	const debugMcp = createDebugMcp({ "port": 0 });

	try {
		const port = await debugMcp.whenListening;
		const post = async (body: unknown, headers: Record<string, string> = {}): Promise<number> => (await fetch(`http://127.0.0.1:${String(port)}/agent/tool`, { "method": "POST", "headers": headers, "body": JSON.stringify(body) })).status;

		assert.equal(await post({ "phase": "start", "id": "u1", "tool": "Bash", "target": "git grep" }), 204);
		assert.equal(await post({ "phase": "end", "id": "u1", "ok": true, "bytes": 1200 }), 204);
		assert.equal(await post({ "phase": "end", "tool": "Edit", "target": "src/a.ts", "ok": false }), 204);
		assert.equal(await post({ "tool": "Bash" }, { "Origin": "https://example.com" }), 403);

		const spans = debugMcp.store.querySpans({ "source": "agent" });

		assert.deepEqual(spans.map((span) => [span.attrs?.["tool"], span.attrs?.["target"], span.attrs?.["via"], span.attrs?.["editorLinked"]]), [["Bash", "git grep", "around", false], ["Edit", "src/a.ts", "around", false]]);
		assert.equal(debugMcp.store.queryLogs({ "source": "agent", "minLevel": "error" }).length, 1);
	} finally {
		await debugMcp.close();
	}
});
