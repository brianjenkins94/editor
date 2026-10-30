/** What's been decided about a file or a name: the ledger, the feature manifest and the docs (code-reach.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const decisions: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "decisions_for",
			"config": {
				"description": "Before changing something, what's been decided about it: the feature ledger's entries (.silo/features.json: removed, parked, an experiment's expiry, each with why) that name it or whose paths hold the file, the feature manifest's features owning it, and each line of the docs (*.md, NEXT.md's queue and decisions among them) naming it, under its heading. Give a file (its path, or just its name) or a name (an identifier, a tool, a hub request, a feature). Returns { target, ledger: [{ name, status, why, since, … }], features: [{ feature, what, docs? }], docs: [{ doc, line, heading, text }], counts }.",
				"inputSchema": { "target": z.string().describe("A file's path or name, or an identifier, tool, hub request or feature.") }
			},
			"handler": async ({ target }, { signal }) => ok(request("decisions.for", { "target": target }, signal))
		})
	}
];

export default decisions;
