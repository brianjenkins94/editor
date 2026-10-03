/**
 * Profiles, said as they arrive: a `.cpuprofile` saved under `.silo/profiles/` — the editor saves one when a preview
 * keeps running slow (profile-files.ts) — is announced, with where its time went a pick away: the app's own functions,
 * most time first, each opened at the line it's written on. It reads nothing but the file, through the workspace file
 * system API, so it works for any profile saved there, however it got there.
 *
 * The app's frames are the ones in the workspace (`file://…`): the editor's profiles are source-mapped as they're saved.
 */
import type { CpuProfile, ProfileEntry } from "../../cpuprofile";
import * as vscode from "vscode";
import { summarize } from "../../cpuprofile";

/** The window a profile is of, from its name: `5173-2026-…` (a port's first window) or `5173-2-2026-…` (its second). */
function windowOf(uri: vscode.Uri): string {
	const match = /^(\d+)(?:-(\d+))?-\d{4}-/u.exec(uri.path.split("/").pop() ?? "");

	return match === null ? "A preview" : `The preview on :${match[1]}${match[2] === undefined ? "" : ` (window ${match[2]})`}`;
}

/** Where a profile's time went: the app's functions, most time first — picking one opens it at its line. */
async function showHotspots(uri: vscode.Uri, hotspots: ProfileEntry[]): Promise<void> {
	type Pick = vscode.QuickPickItem & { "file": vscode.Uri; "line"?: number };
	const picks: Pick[] = hotspots.map((spot) => ({
		"label": "$(flame) " + spot.function,
		"description": `${spot.selfMs} ms self · ${spot.totalMs} ms total`,
		"detail": `${vscode.workspace.asRelativePath(vscode.Uri.parse(spot.url))}:${spot.line}`,
		"file": vscode.Uri.parse(spot.url),
		"line": spot.line
	}));

	picks.push({ "label": "$(file) Open the profile", "detail": vscode.workspace.asRelativePath(uri), "file": uri });

	const picked = await vscode.window.showQuickPick(picks, { "title": `Where ${windowOf(uri).replace(/^The/u, "the")}'s time went`, "placeHolder": hotspots.length === 0 ? "None of it in the app's own code" : "Pick one to go to it" });

	if (picked !== undefined) {
		const line = Math.max(0, (picked.line ?? 1) - 1);

		await vscode.window.showTextDocument(picked.file, { "selection": new vscode.Range(line, 0, line, 0) });
	}
}

export function registerProfiles(context: vscode.ExtensionContext): void {
	const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/profiles/*.cpuprofile", false, true, true);

	context.subscriptions.push(watcher, watcher.onDidCreate(async (uri) => {
		let profile: CpuProfile;

		try {
			profile = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as CpuProfile;
		} catch {
			return; // not a profile we can read
		}

		// The app's own functions: the frames in the workspace's files.
		const hotspots = summarize(profile, 100).functions.filter((entry) => entry.url.startsWith("file://")).slice(0, 10);
		const choice = await vscode.window.showInformationMessage(`${windowOf(uri)} ran slow, so it was profiled.`, "Show Hotspots");

		if (choice === "Show Hotspots") {
			await showHotspots(uri, hotspots);
		}
	}));
}
