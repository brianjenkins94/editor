/** The rules, as the Rules view shows them (`rules.state`: the capabilities extension's `silo.rules.list`, relayed by the bridge). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";

const rules: ToolFamily = ({ request }) => [{
	"timeoutMs": 15000,
	"tool": defineTool({
		"name": "rules_list",
		"config": {
			"description": "Every rule, as the Rules view shows it (RUNNING.md, *Rules*): mine, then the shared contract's — each one's sentence, its JSON, the problem that makes it match nothing if there is one, and for a rule placed in the code where its place is now (its line, or that it's uncertain or lost).",
			"inputSchema": {}
		},
		"handler": async (_args, { signal }) => ok(request("rules.state", undefined, signal))
	})
}];

export default rules;
