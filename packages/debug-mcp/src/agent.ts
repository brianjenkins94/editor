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
import * as fs from "@brianjenkins94/util/fs";
import { logger, sinks } from "@brianjenkins94/util/logger";
import * as path from "node:path";

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

/** How much one tool has been used: through the editor's MCP (`editor`) or around it (`around`, its client's own). */
export interface ToolUse {
	"tool": string;
	"via": "editor" | "around";
	"calls": number;
	"failures": number;
	"ms": number;
	/** Its answers' size, all told, and the largest. */
	"bytes": number;
	"largest": number;
	/** Around the editor: how many while an editor was linked, so it could have been done there. */
	"linked"?: number;
	/** The shell's, while an editor was linked: each command's own program (`git` of `cd a && git log | head`), how often. */
	"programs"?: Record<string, number>;
	"first": number;
	"last": number;
}

/** Every tool's use, most used first, kept since `since` (across restarts, when there's a file to keep it in). */
export interface ToolUses { "since"?: number; "tools": ToolUse[] }

export interface AgentCalls {
	"log": Logger;
	/** Each tool's calls, failures and time so far (`agent.tools`, for the editor's Features and Tests). */
	"usage": () => ToolUses;
	/** `transport` with each `tools/call` across it spanned — with its `session` when it's one of several (sessions.ts). */
	"observe": (transport: Transport, session?: () => string | undefined) => Transport;
	/** One the agent's client reported. */
	"report": (call: AgentToolCall) => void;
	"dispose": () => void;
}

/** What a command starts with that isn't what it does. */
const PRELUDES = new Set(["cd", "export", "source", ".", "set", "env", "time", "caffeinate", "sudo", "nohup", "command", "builtin"]);

/** A command's own program, of its programs in order (the hook's `target`). */
export const commandOf = (programs: string): string | undefined => programs.split(" ").find((program) => program !== "" && !PRELUDES.has(program));

function sizeOf(value: unknown): number {
	return JSON.stringify(value ?? null).length;
}

/** The agent's tool calls, filed in `store`. `editorLinked` says whether an editor tab is linked now: a call around the
 *  editor while one is, is work it could have done. */
export function agentCalls(store: RecordStore, editorLinked: () => boolean, { usageFile }: { "usageFile"?: string } = {}): AgentCalls {
	const sink = (record: HubLogRecord): void => {
		if (record.context?.["source"] === AGENT_SOURCE) {
			store.add(record);
		}
	};

	sinks.push(sink as (typeof sinks)[number]);

	const log = logger({ "source": AGENT_SOURCE });
	const uses = new Map<string, ToolUse>();
	let since: number | undefined;
	let saving: ReturnType<typeof setTimeout> | undefined;

	if (usageFile !== undefined && fs.existsSync(usageFile)) {
		try {
			const kept = JSON.parse(fs.readFileSync(usageFile, "utf8")) as ToolUses;

			since = kept.since;

			for (const use of kept.tools ?? []) {
				uses.set(`${use.via} ${use.tool}`, use);
			}
		} catch (error) {
			log.warn("couldn't read the tools' use so far: it starts again", { "error": String(error) });
		}
	}

	const save = (): void => {
		clearTimeout(saving);
		saving = undefined;

		if (usageFile !== undefined) {
			fs.mkdirSync(path.dirname(usageFile), { "recursive": true });
			fs.writeFileSync(usageFile, JSON.stringify({ "since": since, "tools": [...uses.values()] }, null, "\t") + "\n");
		}
	};

	interface Open { "span": Span; "tool": string; "via": ToolUse["via"]; "started": number; "linked"?: boolean; "program"?: string }

	const opened = (tool: string, via: ToolUse["via"], attrs: Record<string, unknown>, around: Pick<Open, "linked" | "program"> = {}): Open => ({ "span": log.span("debug-mcp.agent.call", { "tool": tool, "via": via, ...attrs }), "tool": tool, "via": via, "started": Date.now(), ...around });
	const reported = new Map<string, Open>();
	const close = ({ span, tool, via, started, linked, program }: Open, ok: boolean, bytes: number | undefined, failure?: string): void => {
		if (!ok) {
			span.error("tool failed", failure === undefined ? {} : { "message": failure });
		}

		span.end(bytes === undefined ? {} : { "bytes": bytes });

		const now = Date.now();
		const use = uses.get(`${via} ${tool}`) ?? { "tool": tool, "via": via, "calls": 0, "failures": 0, "ms": 0, "bytes": 0, "largest": 0, "first": started, "last": now };

		use.calls += 1;
		use.failures += ok ? 0 : 1;
		use.ms += now - started;
		use.bytes = (use.bytes ?? 0) + (bytes ?? 0);
		use.largest = Math.max(use.largest ?? 0, bytes ?? 0);
		use.last = now;

		if (linked === true) {
			use.linked = (use.linked ?? 0) + 1;
		}

		if (program !== undefined) {
			use.programs = { ...use.programs, [program]: (use.programs?.[program] ?? 0) + 1 };
		}
		uses.set(`${via} ${tool}`, use);
		since ??= started;

		if (usageFile !== undefined) {
			saving ??= setTimeout(save, 1000);
			saving.unref?.();
		}
	};

	return {
		"log": log,
		"usage": () => ({ ...since === undefined ? {} : { "since": since }, "tools": [...uses.values()].toSorted((one, other) => other.calls - one.calls) }),
		"observe": (inner, session) => {
			const open = new Map<string | number, Open>();
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

					open.set(message.id, opened(String(params.name), "editor", { "argBytes": sizeOf(params.arguments), ...typeof tab === "string" ? { "tab": tab } : {}, ...session?.() === undefined ? {} : { "session": session() } }));
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
			const attrs = { "editorLinked": editorLinked(), ...call.target === undefined ? {} : { "target": call.target } };
			const program = call.tool === "Bash" && call.target !== undefined && attrs.editorLinked ? commandOf(call.target) : undefined;
			const around = { "linked": attrs.editorLinked, ...program === undefined ? {} : { "program": program } };

			if (call.phase === "start" && call.id !== undefined) {
				reported.set(call.id, opened(call.tool ?? "?", "around", attrs, around));

				return;
			}

			const started = call.id === undefined ? undefined : reported.get(call.id);

			if (call.id !== undefined) {
				reported.delete(call.id);
			}

			close(started ?? opened(call.tool ?? "?", "around", attrs, around), call.ok !== false, call.bytes);
		},
		"dispose": () => {
			if (saving !== undefined) {
				save();
			}

			sinks.splice(sinks.indexOf(sink as (typeof sinks)[number]), 1);
		}
	};
}
