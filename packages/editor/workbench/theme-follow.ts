/**
 * The editor's theme follows the system's, as the shell's does: Web Awesome in the workbench's document on the active
 * VS Code theme (theme/vscode), VS Code's colours told to the shell so it draws in them (theme/vscode-colors), and the
 * colour theme switched to light or dark as the system's preference changes.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { followVsCodeTheme } from "theme/vscode";
import { readVsCodeColors } from "theme/vscode-colors";

/** Web Awesome in the workbench's document, on the active VS Code theme, and its colours told to the shell; returns
 *  what tells them again (on each theme change: followSystemTheme). Nothing before the workbench is there. */
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

/**
 * The colour theme follows the system: `window.autoDetectColorScheme` isn't wired to `prefers-color-scheme` in this
 * monaco-vscode-api build, so `workbench.colorTheme` is set here. The shell is the source of truth (it reliably gets
 * prefers-color-scheme changes; an iframe may not), so what it publishes on `theme.colorScheme` is applied; this frame's
 * own matchMedia is a fallback. Each theme change tells the shell VS Code's colours again (`publishColors`).
 */
export function followSystemTheme(vscode: typeof vscodeApi, hub: Hub, publishColors: () => void): void {
	const apply = (dark: boolean): void => {
		void vscode.workspace.getConfiguration().update("workbench.colorTheme", dark ? "Default Dark+" : "Default Light+", vscode.ConfigurationTarget.Global);
	};
	const system = window.matchMedia("(prefers-color-scheme: dark)");

	// (VS Code has swapped its theme's style when it says so; a frame later, its colours read as the new theme's)
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
