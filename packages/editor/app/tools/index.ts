/// <reference types="vite/client" />
import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import type { ToolFamily } from "./host";
import { createToolHost, toPageTools } from "./page-tools";

const families = import.meta.glob<ToolFamily>("./*/tools.ts", { "eager": true, "import": "default" });

export function editorTools(hub: Hub): PageTool[] {
	const host = createToolHost(hub);

	return toPageTools(Object.keys(families).sort().flatMap((path) => families[path](host)));
}
