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

test("each tool's use is counted, through the editor and around it, kept across a restart, and asked for as agent.tools", async () => {
	const { mkdtempSync, readFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const path = await import("node:path");
	const { createRpcClient } = await import("@brianjenkins94/hub");
	const usageFile = path.join(mkdtempSync(path.join(tmpdir(), "agent-tools-")), "local", "agent-tools.json");
	const first = createDebugMcp({ "port": 0, "usageFile": usageFile });

	try {
		const port = await first.whenListening;
		const inner = fakeTransport();
		const outer = first.agent.observe(inner);

		outer.onmessage = () => {};

		for (const [id, isError] of [[1, false], [2, true]] as const) {
			inner.receive({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "files_read", "arguments": {} } });
			await outer.send({ "jsonrpc": "2.0", "id": id, "result": { "isError": isError, "content": [] } });
		}

		await fetch(`http://127.0.0.1:${String(port)}/agent/tool`, { "method": "POST", "body": JSON.stringify({ "phase": "end", "tool": "Bash", "ok": true }) });

		const asked = await createRpcClient(first.hub).request("agent.tools", undefined, { "timeoutMs": 5000 }) as { "since"?: number; "tools": { "tool": string; "via": string; "calls": number; "failures": number }[] };

		assert.deepEqual(asked.tools.map(({ tool, via, calls, failures }) => [tool, via, calls, failures]), [["files_read", "editor", 2, 1], ["Bash", "around", 1, 0]]);
		assert.equal(typeof asked.since, "number");
	} finally {
		await first.close();
	}

	assert.equal(JSON.parse(readFileSync(usageFile, "utf8")).tools.length, 2, "kept, as it closed");

	const again = createDebugMcp({ "port": 0, "usageFile": usageFile });

	try {
		await again.whenListening;
		assert.deepEqual(again.agent.usage().tools.map(({ tool, calls }) => [tool, calls]), [["files_read", 2], ["Bash", 1]], "what was kept, counted on from");
	} finally {
		await again.close();
	}
});

test("what the use says about the tools: bypasses, candidates, workarounds, friction and oversize, each only past its bar", async () => {
	const { auditUse } = await import("../src/agent-audit.ts");
	const { commandOf } = await import("../src/agent.ts");
	const use = (tool: string, via: "editor" | "around", more: Record<string, unknown> = {}) => ({ "tool": tool, "via": via, "calls": 10, "failures": 0, "ms": 100, "bytes": 1000, "largest": 100, "first": 0, "last": 0, ...more });
	const findings = auditUse([
		use("Read", "around", { "linked": 7 }),
		use("Edit", "around", { "linked": 2 }),
		use("Bash", "around", { "linked": 30, "programs": { "git": 12, "curl": 6, "wc": 9, "lsof": 2 } }),
		use("page_eval", "editor", { "calls": 4 }),
		use("git_push", "editor", { "calls": 5, "failures": 3 }),
		use("runs_affected", "editor", { "largest": 95_000 })
	]);

	assert.deepEqual(findings.map(({ kind, tool, instead }) => [kind, tool, instead]), [
		["bypass", "Bash git", "git_status, git_diff, git_log, git_show, git_commit, git_push…"],
		["oversize", "runs_affected", undefined],
		["bypass", "Read", "files_read"],
		["candidate", "Bash curl", undefined],
		["workaround", "page_eval", undefined],
		["friction", "git_push", undefined]
	]);
	assert.equal(commandOf("cd caffeinate git head"), "git", "a command's own program, past what it starts with");
});
