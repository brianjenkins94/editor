/** Payload capture in every connected tab, on or off. */
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

export default ({ debugMcp }: ToolsContext) => [defineTool({
	"name": "capture_payloads",
	"config": {
		"title": "Capture message payloads",
		"description": "Turn payload capture on or off in every connected tab: while on, each sampled message on every channel (hub links, workers, window messages, sockets, BroadcastChannels, Web Locks, WebRTC signaling and data channels) keeps a size-capped preview of what it carried — get_architecture with `channel` shows them in its recent traffic. Off by default: it records the app's data. Answers whether it's on.",
		"inputSchema": { "on": z.boolean().describe("true to capture, false to stop.") }
	},
	"handler": ({ on }: { "on": boolean }) => {
		debugMcp.capture(on);

		return ok({ "capturing": debugMcp.capturing() });
	}
})];
