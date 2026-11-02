// Claude Code's tool hooks (PreToolUse, PostToolUse, PostToolUseFailure): each tool call reported to debug-mcp as it
// starts and as it ends (src/agent.ts), so an agent's tool use around the editor shows beside its use of the editor's
// own tools, which debug-mcp spans itself and this skips. What a call acted on, never what it carried: a command's
// programs, a file's path. With no debug-mcp running, nothing is sent; it never fails or holds up the call it reports.
import * as path from "node:path";

const PORT = Number(process.env.DEV_HUB_PORT ?? 7378);

/** A command's programs, in order, once each: `cd a && npx eslint b | head` is `cd npx head`, and a substitution's are
 *  its own (`pid=$(lsof -t | head)` is `lsof head`). */
function programsOf(command) {
	return [...new Set(command.replace(/\$\(|[`()]/gu, " ; ").split(/\|\||&&|[|;\n]/u).map((part) => part.trim().split(/\s+/u).find((word) => word !== "" && !/^\w+=/u.test(word) && !word.startsWith("-"))).filter(Boolean))].join(" ");
}

let raw = "";

for await (const chunk of process.stdin) {
	raw += chunk;
}

try {
	const hook = JSON.parse(raw);
	const tool = String(hook.tool_name ?? "");

	if (!tool.startsWith("mcp__debug-mcp__")) {
		const input = hook.tool_input ?? {};
		const file = input.file_path ?? input.notebook_path ?? input.path;
		const target = typeof input.command === "string"
			? programsOf(input.command)
			: typeof file === "string"
				? (path.isAbsolute(file) ? path.relative(hook.cwd ?? process.cwd(), file) : file)
				: undefined;
		const event = String(hook.hook_event_name ?? "");
		const end = event.startsWith("PostToolUse");
		const response = hook.tool_response;
		const ok = event !== "PostToolUseFailure" && response?.is_error !== true && response?.interrupted !== true;

		await fetch(`http://127.0.0.1:${String(PORT)}/agent/tool`, {
			"method": "POST",
			"body": JSON.stringify({ "phase": end ? "end" : "start", "id": hook.tool_use_id, "tool": tool, "target": target, ...end ? { "ok": ok, "bytes": JSON.stringify(response ?? hook.error ?? null).length } : {} }),
			"signal": AbortSignal.timeout(500)
		});
	}
} catch {
	// debug-mcp isn't running, or there was nothing to report
}
