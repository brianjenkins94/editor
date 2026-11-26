/**
 * An agent session whose debug-mcp didn't get the port (NEXT.md item 2, *Working in it*: one session a machine drove the
 * editor, and a second had no tools, nothing saying why). Its stdio is relayed, message for message, to the MCP the
 * port's debug-mcp serves over HTTP (sessions.ts): the same tools, tabs and records. When that one goes (its session
 * ended), this one takes the port itself, or relays to whichever did: its client's `initialize` is asked again of the new
 * one, and its client is told the tools may have changed. A call that was waiting on the old one fails, saying so, rather
 * than run twice. A port another program holds is said in the session's instructions, which its agent reads.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import type { DebugMcp } from "./server.ts";
import * as fs from "@brianjenkins94/util/fs";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/layout";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import { createMcpServer } from "./mcp.ts";
import { createDebugMcp } from "./server.ts";
import { HERE, MCP_PATH } from "./sessions.ts";

/** Where a session's messages go: the port's debug-mcp over HTTP, this process's own once it holds the port, or, the port
 *  another program's, a server with nothing but instructions saying so. */
export interface Upstream {
	"transport": Transport;
	"kind": "relayed" | "own" | "none";
	/** Whether it can still answer (relayed: whether its debug-mcp still has this session). */
	"alive": () => Promise<boolean>;
}

/** How many times the port is looked at, taken or relayed to, before the session is told another program has it. */
const TRIES = 5;
const TRY_MS = 200;
/** How long `initialize`, asked again of a new upstream, may take. */
const REINIT_MS = 10_000;
const PROBE_MS = 2000;

const pause = async (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** What's on `port`: a debug-mcp (and whether it has `session` open), nothing listening, or another program. */
async function onPort(port: number, session?: string): Promise<{ "is": "debug-mcp" | "nothing" | "other"; "open"?: boolean }> {
	try {
		const response = await fetch(`http://localhost:${String(port)}${MCP_PATH}${session === undefined
			? ""
			: `?session=${encodeURIComponent(session)}`}`, {
			"signal": AbortSignal.timeout(PROBE_MS)
		});
		const said = await response.json().catch(() => undefined) as { "server"?: unknown; "open"?: unknown } | undefined;

		return said?.server === HERE.server
			? { "is": "debug-mcp", "open": said.open === true }
			: { "is": "other" };
	} catch (error) {
		// (refused, on either of localhost's addresses: nothing listening; anything else — a timeout — something that is)
		return {
			"is": JSON.stringify((error as { "cause"?: unknown }).cause ?? {}, ["code", "errors"]).includes("ECONNREFUSED")
				? "nothing"
				: "other"
		};
	}
}

export interface Port {
	/** The port, taken by a debug-mcp of this process's own: undefined when something has it. */
	"take": () => Promise<DebugMcp | undefined>;
	/** An upstream for a session: this process's debug-mcp if it holds the port, else whichever does. */
	"connect": () => Promise<Upstream>;
	/** This process's debug-mcp, once it has taken the port. */
	"owned": () => DebugMcp | undefined;
}

/** Where each tool's use is kept: DEBUG_MCP_USAGE_FILE (`none`, nowhere), else where silo keeps what's this machine's, in
 *  the repository it was started in (its root's .silo/local), else the folder itself. */
function usageFile(): { "usageFile"?: string } {
	const asked = process.env["DEBUG_MCP_USAGE_FILE"];

	if (asked !== undefined && asked !== "") {
		return asked === "none" ? {} : { "usageFile": path.resolve(asked) };
	}

	const git = fs.closest(process.cwd(), ".git");

	return { "usageFile": path.join(git === undefined ? process.cwd() : path.dirname(git), LOCAL_DIR, "agent-tools.json") };
}

/** `port`, for a session to be served on: taken, or relayed to. */
export function portOf(port: number): Port {
	let owned: DebugMcp | undefined;

	const take = async (): Promise<DebugMcp | undefined> => {
		if (owned !== undefined) {
			return owned;
		}

		const debugMcp = createDebugMcp({ "port": port, ...usageFile() });

		try {
			await debugMcp.whenListening;
		} catch (error) {
			await debugMcp.close().catch(() => undefined);

			if ((error as { "code"?: string }).code === "EADDRINUSE") {
				return undefined;
			}

			throw error;
		}

		owned = debugMcp;

		return owned;
	};

	return {
		"take": take,
		"owned": () => owned,
		"connect": async () => {
			for (let tries = 1; ; tries += 1) {
				const own = await take();

				if (own !== undefined) {
					const [ours, theirs] = InMemoryTransport.createLinkedPair();

					await createMcpServer(own).connect(own.agent.observe(theirs));

					return {
						"transport": ours,
						"kind": "own",
						"alive": async () => true
					};
				}

				const there = await onPort(port);

				if (there.is === "debug-mcp") {
					const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${String(port)}${MCP_PATH}`));

					return {
						"transport": transport,
						"kind": "relayed",
						"alive": async () => (await onPort(port, transport.sessionId)).open === true
					};
				}

				if (there.is === "other" || tries === TRIES) {
					const [ours, theirs] = InMemoryTransport.createLinkedPair();

					await new McpServer({ "name": "debug-mcp", "version": "0.0.0" }, { "instructions": `debug-mcp has none of the editor's tools in this session: port ${String(port)} is held by a program that isn't a debug-mcp this new (an older checkout's, or another program), so this one couldn't take it or relay to it. Free the port (\`lsof -ti :${String(port)}\` says what has it) and reconnect this MCP server, or set DEV_HUB_PORT for both the editor and debug-mcp.` }).connect(theirs);

					return {
						"transport": ours,
						"kind": "none",
						"alive": async () => true
					};
				}

				// (nothing there: the debug-mcp that had it just went — take it)
				await pause(TRY_MS);
			}
		}
	};
}

export interface Relay {
	"close": () => Promise<void>;
}

/** `client`'s messages to an upstream from `connect`, and back; a new one when it goes. Starts `client`. */
export async function relay(client: Transport, connect: () => Promise<Upstream>, say: (line: string) => void = (line) => { console.error(line); }): Promise<Relay> {
	let upstream: Upstream | undefined;
	let initialize: JSONRPCRequest | undefined;
	let initialized = false;
	/** The client's requests the upstream hasn't answered. */
	const waiting = new Set<number | string>();
	/** Those still being sent: one whose send fails is sent again to the next upstream, not refused. */
	const sending = new Set<number | string>();
	let replays = 0;
	let queue = Promise.resolve();
	let closed = false;

	const refuse = async (id: number | string, why: string): Promise<void> => {
		await client.send({
			"jsonrpc": "2.0",
			"id": id,
			"error": { "code": -32_603, "message": why }
		}).catch(() => undefined);
	};

	const attach = async (): Promise<Upstream> => {
		const next = await connect();
		const replayId = `debug-mcp-relay-${String(replays += 1)}`;
		let reinit: ((message: JSONRPCMessage) => void) | undefined;

		next.transport.onmessage = (message) => {
			if ("id" in message && message.id === replayId) {
				reinit?.(message);

				return;
			}

			if ("id" in message && message.id !== undefined && ("result" in message || "error" in message)) {
				waiting.delete(message.id);

				// (initialize's answer: what's asked of it from now on says which version was agreed)
				const agreed = "result" in message
					? (message.result as { "protocolVersion"?: unknown }).protocolVersion
					: undefined;

				if (typeof agreed === "string") {
					next.transport.setProtocolVersion?.(agreed);
				}
			}

			void client.send(message).catch(() => undefined);
		};

		next.transport.onerror = (error) => {
			void next.alive().then((alive) => {
				if (!alive) {
					lose(next, error.message);
				}
			});
		};

		next.transport.onclose = () => { lose(next, "it closed"); };
		await next.transport.start();
		say(`[debug-mcp] ${next.kind === "own"
			? "took the port"
			: next.kind === "relayed"
				? "relaying to the debug-mcp on the port"
				: "the port is another program's: no tools"}`);

		// (a later one: its client initialized with the one before)
		if (initialize !== undefined) {
			const answer = await new Promise<JSONRPCMessage>((resolve, reject) => {
				reinit = resolve;
				setTimeout(() => { reject(new Error("no answer to initialize")); }, REINIT_MS).unref();
				next.transport.send({ ...initialize!, "id": replayId }).catch(reject);
			});

			if (!("result" in answer)) {
				throw new Error(`initialize, asked again, failed: ${JSON.stringify(answer)}`);
			}

			next.transport.setProtocolVersion?.((answer.result as { "protocolVersion": string }).protocolVersion);

			if (initialized) {
				await next.transport.send({ "jsonrpc": "2.0", "method": "notifications/initialized" });
			}

			await client.send({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }).catch(() => undefined);
		}

		upstream = next;

		return next;
	};

	/** `gone` is gone: what waited on it fails, and another is found at once (its tabs and the port want an owner). */
	function lose(gone: Upstream, why: string): void {
		if (upstream !== gone || closed) {
			return;
		}

		upstream = undefined;
		say(`[debug-mcp] lost its upstream (${why})`);

		for (const id of waiting) {
			if (!sending.has(id)) {
				void refuse(id, `debug-mcp's upstream went before it answered (${why}); ask again`);
				waiting.delete(id);
			}
		}
		void gone.transport.close().catch(() => undefined);
		queue = queue.then(async () => {
			if (upstream === undefined && !closed) {
				await attach().catch((error: unknown) => { say(`[debug-mcp] no upstream: ${String(error)}`); });
			}
		});
	}

	const forward = async (message: JSONRPCMessage): Promise<void> => {
		const request = "method" in message && "id" in message
			? message.id
			: undefined;

		for (let attempt = 1; ; attempt += 1) {
			let to: Upstream;

			try {
				to = upstream ?? await attach();
			} catch (error) {
				if (request !== undefined) {
					await refuse(request, `debug-mcp has no upstream: ${error instanceof Error
						? error.message
						: String(error)}`);
				}

				return;
			}

			if (request !== undefined) {
				waiting.add(request);
				sending.add(request);
			}

			try {
				await to.transport.send(message).finally(() => {
					if (request !== undefined) {
						sending.delete(request);
					}
				});

				// (once it's sent: asked again of each upstream after this one)
				if (isInitializeRequest(message)) {
					initialize = message as JSONRPCRequest;
				} else if ("method" in message && message.method === "notifications/initialized") {
					initialized = true;
				}

				return;
			} catch (error) {
				if (request !== undefined) {
					waiting.delete(request);
				}

				// (not sent, as its upstream is gone: once more, to the next)
				if (attempt === 1 && !await to.alive()) {
					lose(to, error instanceof Error
						? error.message
						: String(error));
					continue;
				}

				if (request !== undefined) {
					await refuse(request, error instanceof Error
						? error.message
						: String(error));
				}

				return;
			}
		}
	};

	client.onmessage = (message) => {
		queue = queue.then(async () => forward(message)).catch(() => undefined);
	};

	await client.start();

	return {
		"close": async () => {
			closed = true;

			if (upstream?.transport instanceof StreamableHTTPClientTransport) {
				await upstream.transport.terminateSession().catch(() => undefined);
			}

			await upstream?.transport.close().catch(() => undefined);
		}
	};
}
