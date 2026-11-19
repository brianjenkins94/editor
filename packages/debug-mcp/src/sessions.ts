/**
 * Every agent session on this machine, through the one debug-mcp that holds the port (NEXT.md item 2, *Working in it*:
 * one session drove the editor, and a second had no tools, nothing saying why). A second session's debug-mcp finds the
 * port taken and relays its stdio here (relay.ts), to MCP over HTTP at `/mcp`: a server of its own for each session, on
 * this one's store, tabs and agent spans. Only this machine's own programs reach it: from loopback, with no Origin (a
 * page never), to a Host that is this machine's name for itself. `GET /mcp` with no session answers that this is a
 * debug-mcp, so a relay can tell one from another program on the port.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DebugMcp } from "./server.ts";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp.ts";

export const MCP_PATH = "/mcp";
/** What `GET /mcp` without a session answers: a debug-mcp is here. */
export const HERE = { "server": "debug-mcp" };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const OWN_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The most a request's body may be. */
const MAX_BODY = 4 * 1024 * 1024;

export interface Sessions {
	/** Answer `request` if it's for `/mcp`; false if it isn't. */
	"handle": (request: IncomingMessage, response: ServerResponse) => boolean;
	/** The sessions open now. */
	"count": () => number;
	"close": () => Promise<void>;
}

function fromThisMachine(request: IncomingMessage): boolean {
	const host = (request.headers.host ?? "").replace(/:\d+$/u, "");

	return request.headers.origin === undefined && LOOPBACK.has(request.socket.remoteAddress ?? "") && OWN_NAMES.has(host);
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
	let body = "";

	request.setEncoding("utf8");

	for await (const chunk of request) {
		body += chunk as string;

		if (body.length > MAX_BODY) {
			throw new Error("too large");
		}
	}

	return JSON.parse(body) as unknown;
}

function answer(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

/** `/mcp`'s sessions, each served from `debugMcp()` (asked as each starts: the server it's part of is still being made). */
export function mcpSessions(debugMcp: () => DebugMcp): Sessions {
	const open = new Map<string, StreamableHTTPServerTransport>();

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (!fromThisMachine(request)) {
			response.writeHead(403).end();

			return;
		}

		const id = request.headers["mcp-session-id"];

		if (typeof id === "string") {
			const transport = open.get(id);

			if (transport === undefined) {
				answer(response, 404, {
					"jsonrpc": "2.0",
					"error": { "code": -32_001, "message": "no such session (debug-mcp restarted?)" },
					"id": null
				});

				return;
			}

			await transport.handleRequest(request, response, request.method === "POST"
				? await bodyOf(request)
				: undefined);

			return;
		}

		// (what's here, and whether a relay's session still is: relay.ts asks as its upstream errs)
		if (request.method !== "POST") {
			const session = new URL(request.url ?? "/", "http://localhost").searchParams.get("session");

			answer(response, 200, {
				...HERE,
				...session === null
					? {}
					: {
							"open": open.has(session)
						}
			});

			return;
		}

		const body = await bodyOf(request);

		if (!isInitializeRequest(body)) {
			answer(response, 400, {
				"jsonrpc": "2.0",
				"error": { "code": -32_000, "message": "a session starts with initialize" },
				"id": null
			});

			return;
		}

		const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
			"sessionIdGenerator": randomUUID,
			"onsessioninitialized": (session) => { open.set(session, transport); }
		});
		const server = createMcpServer(debugMcp());
		// (its end is an event elsewhere — the relay's DELETE, or this debug-mcp closing — so a handle, ended on close)
		const span = debugMcp().agent.log.span("debug-mcp.sessions.session", {});

		transport.onclose = () => {
			if (transport.sessionId !== undefined) {
				open.delete(transport.sessionId);
			}

			span.end({});
		};

		await server.connect(debugMcp().agent.observe(transport, () => transport.sessionId));
		await transport.handleRequest(request, response, body);
	};

	return {
		"handle": (request, response) => {
			if (new URL(request.url ?? "/", "http://localhost").pathname !== MCP_PATH) {
				return false;
			}

			handle(request, response).catch((error: unknown) => {
				if (!response.headersSent) {
					answer(response, 400, {
						"jsonrpc": "2.0",
						"error": {
							"code": -32_700,
							"message": error instanceof Error
								? error.message
								: String(error)
						},
						"id": null
					});
				}
			});

			return true;
		},
		"count": () => open.size,
		"close": async () => {
			await Promise.all([
				...open.values()
			].map(async (transport) => transport.close()));
		}
	};
}
