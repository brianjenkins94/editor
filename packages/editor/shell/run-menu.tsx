/** @jsxImportSource preact */
/**
 * The Run menu (RUNNING.md, *The model*), in the top bar: the file in the editor, in the debugger, or one of the workspace's scripts
 * (workbench/tasks.ts). A script whose service is up shows its preview, rather than starting it twice.
 */
import type { ShellContext, ShellFeature } from "./feature";
import { Play } from "lucide";
import { useState } from "preact/hooks";
import { Icon } from "./icon";
import "theme/components/button";
import "theme/components/divider";
import "theme/components/dropdown";
import "theme/components/dropdown-item";

interface Script { "name": string; "folder": string; "label": string; "line": string; "port"?: number }

const ASK = { "timeoutMs": 30_000, "waitForResponderMs": 10_000 };

function RunControl({ shell }: { "shell": ShellContext }) {
	const [scripts, setScripts] = useState<Script[]>([]);

	return (
		<wa-dropdown
			size="small"
			placement="bottom-start"
			onwa-show={() => {
				void shell.rpc.request("tasks.list", undefined, ASK).then((answer) => {
					setScripts(answer as Script[]);
				}, () => undefined);
			}}
			onwa-select={(event: CustomEvent<{ "item": { "value": string } }>) => {
				const { value } = event.detail.item;
				const script = scripts[Number(value)];

				void (script === undefined
					? shell.rpc.request("tasks.runFile", undefined, ASK)
					: shell.rpc.request("tasks.run", { "name": script.name, "folder": script.folder }, ASK)).catch(() => undefined);
			}}
		>
			<wa-button id="shell-run" slot="trigger" appearance="plain" size="small" with-caret title="Run">
				<span slot="start"><Icon node={Play} /></span>
				{"Run"}
			</wa-button>

			<wa-dropdown-item value="file">Run the file in the editor</wa-dropdown-item>

			{scripts.length === 0
				? null
				: <wa-divider />}

			{scripts.map((script, index) => (
				<wa-dropdown-item key={script.label} value={String(index)} title={script.line}>
					{script.port === undefined
						? script.label
						: `${script.label}: show the preview, on :${String(script.port)}`}
				</wa-dropdown-item>
			))}
		</wa-dropdown>
	);
}

export const runMenu: ShellFeature = {
	"control": { "place": "start", "Control": RunControl }
};
