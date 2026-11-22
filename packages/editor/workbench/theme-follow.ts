import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { followVsCodeTheme } from "theme/vscode";
import { readVsCodeColors } from "theme/vscode-colors";

export function showVsCodeTheme(hub: Hub): (() => void) | undefined {
	const workbench = document.querySelector<HTMLElement>(".monaco-workbench");

	if (workbench === null) {
		return undefined;
	}

	followVsCodeTheme(workbench);

	const publish = (): void => {
		hub.publish("theme.colors", readVsCodeColors(workbench));
	};

	publish();

	return publish;
}

export function followSystemTheme(vscode: typeof vscodeApi, hub: Hub, publishColors: () => void): void {
	const apply = (dark: boolean): void => {
		void vscode.workspace.getConfiguration().update("workbench.colorTheme", dark ? "Default Dark+" : "Default Light+", vscode.ConfigurationTarget.Global);
	};
	const system = window.matchMedia("(prefers-color-scheme: dark)");

	vscode.window.onDidChangeActiveColorTheme(() => {
		requestAnimationFrame(publishColors);
	});
	hub.subscribe("theme.colorScheme", (data) => {
		apply((data as { "dark"?: boolean } | null)?.dark ?? system.matches);
	});
	system.addEventListener("change", () => {
		apply(system.matches);
	});
}
