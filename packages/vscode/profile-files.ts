/**
 * A slow preview's profile, as a file: when a preview runs slow the shell profiles it on its own (`preview.profiled`,
 * preview-profile.ts); here it's saved as a `.cpuprofile` under `.silo/local/profiles/` (silo keeps `local/` out of git:
 * a raw profile is megabytes, and its hotspots are what the evidence keeps) — the profile anything
 * can read: DevTools, a desktop profile viewer, the insights extension (which watches for them and says where the time
 * went).
 *
 * Saved as written, not as served: the dev server compiles TypeScript and JSX away and puts its HMR setup in front, so
 * each of the app's frames is moved from the preview's address (`/__virtual__/<tab>/<port>/src/Burner`) to its file in
 * the workspace (`file:///workspace/src/Burner.tsx`) and the line and column it's written on, through the served module's
 * inline source map. The editor's own frames (a docked preview shares its thread) are left as they are.
 *
 * Named for its window and when: `5173-2026-10-03T12-49-35Z.cpuprofile` (`5173-2` for a port's second window).
 *
 * Runs in the workbench realm: the workspace filesystem, and the run registry that knows where each dev server serves.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { CpuProfile } from "./cpuprofile";
import type { PreviewProfile } from "./preview-profile";
import type { RunRegistry } from "./runs";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/evidence";
import { ensureSiloFiles } from "./evidence";
import { PREVIEW_PROFILED } from "./preview-profile";
import { inlineSourceMap, originalPosition } from "./sourcemap";
import { VIRTUAL_RE } from "./virtual-path";

/** Where profiles are saved. */
export const PROFILES = `/workspace/${LOCAL_DIR}/profiles`;

/**
 * `profile` with the app's frames moved to where they're written: each served from the preview on `port` (whose dev
 * server serves `root`), through its module's source map — the map names its source beside the module (`Burner.tsx`
 * for `/src/Burner`), so that's the file, extension and all. A module without one keeps its lines, at its path.
 */
async function sourceMapped(profile: CpuProfile, port: number, root: string): Promise<CpuProfile> {
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
	const base = root.replace(/\/$/u, "");
	const nodes = await Promise.all(profile.nodes.map(async (node) => {
		const match = VIRTUAL_RE.exec(node.callFrame.url);
		const path = match === null || Number(match[2]) !== port ? undefined : decodeURIComponent(match[3] ?? "/");

		// Not the app's source: the editor's own code, another server's, the page itself, a dependency, the dev server's.
		if (path === undefined || path === "/" || path.startsWith("/@") || path.includes("/node_modules/")) {
			return node;
		}

		const map = await mapOf(node.callFrame.url);
		const original = map === undefined || node.callFrame.lineNumber < 0 ? undefined : originalPosition(map, node.callFrame.lineNumber, Math.max(0, node.callFrame.columnNumber));
		const file = original === undefined ? base + path : base + path.slice(0, path.lastIndexOf("/") + 1) + original.source.replace(/^.*\//u, "");

		return { ...node, "callFrame": { ...node.callFrame, "url": "file://" + file, "lineNumber": original?.line ?? node.callFrame.lineNumber, "columnNumber": original?.column ?? node.callFrame.columnNumber } };
	}));

	return { ...profile, "nodes": nodes };
}

export function installProfileFiles(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry): void {
	hub.subscribe(PREVIEW_PROFILED, (data) => {
		const { port, window: key, profile } = (data ?? {}) as Partial<PreviewProfile> & { "port"?: number; "window"?: string };
		const run = typeof port === "number" ? runs.runningService((candidate) => candidate.port === port) : undefined;

		if (run === undefined || port === undefined || profile === undefined) {
			return; // its server has stopped since
		}

		const name = `${String(key ?? port).replace("~", "-")}-${new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z")}.cpuprofile`;

		void (async () => {
			try {
				await ensureSiloFiles(vscode);
				await vscode.workspace.fs.writeFile(vscode.Uri.file(`${PROFILES}/${name}`), new TextEncoder().encode(JSON.stringify(await sourceMapped(profile, port, run.cwd))));
			} catch {
				// Nowhere to keep it.
			}
		})();
	});
}
