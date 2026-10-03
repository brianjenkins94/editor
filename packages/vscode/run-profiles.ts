/**
 * Profiles kept with the runs they were taken from: when a preview runs slow, the shell profiles it on its own
 * (`preview.profiled`, preview-profile.ts); here the `.cpuprofile` is saved under `.silo/profiles/` (out of git) and kept
 * with the dev server's run (runs.ts) — with its hotspots: the app's own functions that took the most time, each mapped
 * from the preview's address back to its file and line in the workspace (through the module's source map), so the
 * running list can take you there.
 *
 * Runs in the workbench realm (the vscode API and the run registry live here).
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { PreviewProfile } from "./preview-profile";
import type { RunProfile, RunRegistry } from "./runs";
import { PREVIEW_PROFILED } from "./preview-profile";
import { inlineSourceMap, originalPosition } from "./sourcemap";
import { VIRTUAL_RE } from "./virtual-path";

const PROFILES = "/workspace/.silo/profiles";

/**
 * The app's functions in a profile, most time first: the ones served from the preview, each where it's written — the
 * profile has the served module's line and column, and the module's inline source map has where that came from (the
 * dev server compiles TypeScript and JSX away, and puts its HMR setup in front).
 */
async function hotspots(summary: PreviewProfile["summary"], port: number, cwd: string): Promise<RunProfile["hotspots"]> {
	const maps = new Map<string, Promise<ReturnType<typeof inlineSourceMap>>>();
	const mapOf = (url: string): Promise<ReturnType<typeof inlineSourceMap>> => {
		let map = maps.get(url);

		if (map === undefined) {
			// The module as the preview got it (the service worker serves this realm the same address).
			map = fetch(url).then(async (response) => (response.ok ? inlineSourceMap(await response.text()) : undefined), () => undefined);
			maps.set(url, map);
		}

		return map;
	};
	const spots: RunProfile["hotspots"] = [];

	for (const entry of summary.functions) {
		const match = VIRTUAL_RE.exec(entry.url);

		if (match === null || Number(match[2]) !== port) {
			continue; // the editor's own code (a docked preview shares its thread), or another server's
		}

		const path = decodeURIComponent(match[3] ?? "/");

		// Not a source file of the app's: the page itself (an inline script), a dependency, or a dev server module.
		if (path === "/" || path.startsWith("/@") || path.includes("/node_modules/")) {
			spots.push({ "function": entry.function, "line": entry.line, "selfMs": entry.selfMs, "totalMs": entry.totalMs });
			continue;
		}

		const root = cwd.replace(/\/$/u, "");
		const map = await mapOf(entry.url);
		const original = map === undefined ? undefined : originalPosition(map, entry.line - 1, entry.column - 1);
		// The map names its source beside the module (`burn.ts` for `/src/burn`): that's the file, extension and all.
		const file = original === undefined ? root + path : root + path.slice(0, path.lastIndexOf("/") + 1) + original.source.replace(/^.*\//u, "");

		spots.push({ "function": entry.function, "file": file, "line": original === undefined ? entry.line : original.line + 1, "selfMs": entry.selfMs, "totalMs": entry.totalMs });

		if (spots.length === 10) {
			break;
		}
	}

	return spots;
}

/** The files as they are in the workspace — for a module without a map: the dev server serves `./burn` as the app
 *  imported it, not `burn.ts`. */
async function resolveFiles(vscode: typeof vscodeApi, spots: RunProfile["hotspots"]): Promise<RunProfile["hotspots"]> {
	const exists = async (path: string): Promise<boolean> => vscode.workspace.fs.stat(vscode.Uri.file(path)).then((stat) => stat.type === vscode.FileType.File, () => false);
	const found = new Map<string, string | undefined>();

	for (const spot of spots) {
		if (spot.file !== undefined && !found.has(spot.file)) {
			let resolved: string | undefined;

			for (const candidate of [spot.file, ...["ts", "tsx", "js", "jsx", "mjs", "mts"].map((extension) => `${spot.file}.${extension}`), `${spot.file}/index.ts`, `${spot.file}/index.js`]) {
				if (await exists(candidate)) {
					resolved = candidate;
					break;
				}
			}

			found.set(spot.file, resolved);
		}
	}

	return spots.map((spot) => ({ ...spot, "file": spot.file === undefined ? undefined : found.get(spot.file) }));
}

export function installRunProfiles(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry): void {
	hub.subscribe(PREVIEW_PROFILED, (data) => {
		const { port, window: key, profile, summary } = (data ?? {}) as Partial<PreviewProfile> & { "port"?: number; "window"?: string };
		const run = typeof port === "number" ? runs.runningService((candidate) => candidate.port === port) : undefined;

		if (run === undefined || port === undefined || profile === undefined || summary === undefined) {
			return; // its server has stopped since
		}

		const at = Date.now();
		const path = `${PROFILES}/${String(key ?? port).replace("~", "-")}-${new Date(at).toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z")}.cpuprofile`;

		void (async () => {
			try {
				await vscode.workspace.fs.writeFile(vscode.Uri.file(path), new TextEncoder().encode(JSON.stringify(profile)));
			} catch {
				return; // nowhere to keep it
			}

			runs.addProfile(port, { "path": path, "at": at, "hotspots": await resolveFiles(vscode, await hotspots(summary, port, run.cwd)) });
		})();
	});
}
