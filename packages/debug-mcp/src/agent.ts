/**
 * The agent's tool use, observable as the editor's own work is: every tool call a span on the `agent` source, in this
 * store, so logs_query and spans_query answer which tools an agent used, which failed or were slow, which answered with
 * more than it could read, and what it did around the editor while one was open. The editor's tools are spanned as they
 * cross this MCP server's transport (`observe`); every other tool — the shell, the file tools, what goes around the
 * editor — as the agent's own client posts it (`POST /agent/tool`, from Claude Code's hooks: ../agent-hook.mjs).
 */
import type { Logger, Span } from "@brianjenkins94/util/logger";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { HubLogRecord, RecordStore } from "./store.ts";
import { logger, sinks } from "@brianjenkins94/util/logger";

export const AGENT_SOURCE = "agent";

/** A tool call the agent's client reports: `start` as it begins, `end` with how it went; either alone is one event. */
export interface AgentToolCall {
	"phase"?: "start" | "end";
	/** The client's id for the call, which pairs its start with its end. */
	"id"?: string;
	"tool"?: string;
	/** What it acted on, without its contents: a command's programs, a file's path. */
	"target"?: string;
	"ok"?: boolean;
	/** The answer's size. */
	"bytes"?: number;
}

export interface AgentCalls {
	"log": Logger;
	/** `transport` with each `tools/call` across it spanned. */
	"observe": (transport: Transport) => Transport;
	/** One the agent's client reported. */
	"report": (call: AgentToolCall) => void;
	"dispose": () => void;
}

function sizeOf(value: unknown): number {
	return JSON.stringify(value ?? null).length;
}

/** The agent's tool calls, filed in `store`. `editorLinked` says whether an editor tab is linked now: a call around the
 *  editor while one is, is work it could have done. */
export function agentCalls(store: RecordStore, editorLinked: () => boolean): AgentCalls {
	const sink = (record: HubLogRecord): void => {
		if (record.context?.["source"] === AGENT_SOURCE) {
			store.add(record);
		}
	};

	sinks.push(sink as (typeof sinks)[number]);

	const log = logger({ "source": AGENT_SOURCE });
	const reported = new Map<string, Span>();
	const close = (span: Span, ok: boolean, bytes: number | undefined, failure?: string): void => {
		if (!ok) {
			span.error("tool failed", failure === undefined ? {} : { "message": failure });
		}

		span.end(bytes === undefined ? {} : { "bytes": bytes });
	};

	return {
		"log": log,
		"observe": (inner) => {
			const open = new Map<string | number, Span>();
			const outer: Transport = {
				"start": async () => inner.start(),
				"close": async () => inner.close(),
				"send": async (message, options) => {
					if ("id" in message && ("result" in message || "error" in message)) {
						const span = open.get(message.id);

						if (span !== undefined) {
							open.delete(message.id);

							const result = "result" in message ? message.result as { "isError"?: boolean; "content"?: { "text"?: string }[] } : undefined;
							const failed = "error" in message || result?.isError === true;

							close(span, !failed, sizeOf("result" in message ? message.result : message.error), failed ? ("error" in message ? message.error.message : result?.content?.[0]?.text)?.slice(0, 200) : undefined);
						}
					}

					return inner.send(message, options);
				}
			};

			inner.onmessage = (message: JSONRPCMessage, extra) => {
				if ("method" in message && message.method === "tools/call" && "id" in message) {
					const params = (message.params ?? {}) as { "name"?: unknown; "arguments"?: Record<string, unknown> };
					const tab = params.arguments?.["tab"];

					open.set(message.id, log.span("debug-mcp.agent.call", { "tool": String(params.name), "via": "editor", "argBytes": sizeOf(params.arguments), ...typeof tab === "string" ? { "tab": tab } : {} }));
				}

				outer.onmessage?.(message, extra);
			};
			inner.onclose = () => {
				outer.onclose?.();
			};
			inner.onerror = (error) => {
				outer.onerror?.(error);
			};

			return outer;
		},
		"report": (call) => {
			const attrs = { "tool": call.tool ?? "?", "via": "around", "editorLinked": editorLinked(), ...call.target === undefined ? {} : { "target": call.target } };

			if (call.phase === "start" && call.id !== undefined) {
				reported.set(call.id, log.span("debug-mcp.agent.call", attrs));

				return;
			}

			const started = call.id === undefined ? undefined : reported.get(call.id);

			if (call.id !== undefined) {
				reported.delete(call.id);
			}

			close(started ?? log.span("debug-mcp.agent.call", attrs), call.ok !== false, call.bytes);
		},
		"dispose": () => {
			sinks.splice(sinks.indexOf(sink as (typeof sinks)[number]), 1);
		}
	};
}
