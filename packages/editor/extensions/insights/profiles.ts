/**
 * Where a preview's time went: each profile the editor keeps (workbench/profile-files.ts, a `.cpuprofile` under
 * `.silo/local/profiles/`) is said as it's saved (`insights.profiles.saved`). One you asked for (the Profile button in a
 * preview window's title bar) opens on the app's own functions, most time first, each opened at the line it's written
 * on; one taken because the page kept running slow is a notification with them a click away. It reads nothing but the
 * file, so it works for any profile saved there, however it got there.
 *
 * The app's frames are the ones in the workspace (`file://…`): the editor's profiles are source-mapped as they're saved.
 */
import type { CpuProfile, ProfileEntry } from "@brianjenkins94/editor-api/cpuprofile";
import { summarize } from "@brianjenkins94/editor-api/cpuprofile";
import * as vscode from "vscode";

/** The window a profile is of, from its name: `5173-1-2026-…` (a port's first window), `5173-2-2026-…` (its second). */
function windowOf(uri: vscode.Uri): string {
	const match = /^(\d+)-(\d+)-\d{4}-/u.exec(uri.path.split("/").pop() ?? "");

	if (match === null) {
		return "a preview";
	}

	return `the preview on :${match[1]!}${match[2] === "1" ? "" : ` (window ${match[2]!})`}`;
}

/** Where a profile's time went: the app's functions, most time first; picking one opens it at its line. */
async function showHotspots(uri: vscode.Uri, hotspots: ProfileEntry[]): Promise<void> {
	type Pick = vscode.QuickPickItem & { "file": vscode.Uri; "line"?: number };
	const picks: Pick[] = hotspots.map((spot) => ({
		"label": `$(flame) ${spot.function}`,
		"description": `${String(spot.selfMs)} ms self · ${String(spot.totalMs)} ms total`,
		"detail": `${vscode.workspace.asRelativePath(vscode.Uri.parse(spot.url))}:${String(spot.line)}`,
		"file": vscode.Uri.parse(spot.url),
		"line": spot.line
	}));

	picks.push({ "label": "$(file) Open the profile", "detail": vscode.workspace.asRelativePath(uri), "file": uri });

	const picked = await vscode.window.showQuickPick(picks, {
		// (it stays while you move the preview window it may be under: they're over the editor)
		"ignoreFocusOut": true,
		"title": `Where ${windowOf(uri)}'s time went`,
		"placeHolder": hotspots.length === 0 ? "None of it in the app's own code" : "Pick one to go to it"
	});

	if (picked !== undefined) {
		const line = Math.max(0, (picked.line ?? 1) - 1);

		await vscode.window.showTextDocument(picked.file, { "selection": new vscode.Range(line, 0, line, 0) });
	}
}

export function registerProfiles(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand("insights.profiles.saved", async (uri: vscode.Uri, why: "asked" | "slow") => {
		let profile: CpuProfile;

		try {
			profile = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as CpuProfile;
		} catch {
			return; // not a profile we can read
		}

		// The app's own functions: the frames in the workspace's files.
		const hotspots = summarize(profile, 100).functions.filter((entry) => entry.url.startsWith("file://")).slice(0, 10);

		if (why === "asked") {
			await showHotspots(uri, hotspots);
		} else if (await vscode.window.showInformationMessage(`${windowOf(uri).replace(/^t/u, "T")} kept running slow, so it was profiled.`, "Show Hotspots") === "Show Hotspots") {
			await showHotspots(uri, hotspots);
		}
	}));
}
