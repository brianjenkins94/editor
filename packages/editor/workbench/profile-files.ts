/**
 * A preview's profile, as a file: each one the shell takes (`preview.profiled`, shell/preview-profile.ts: asked for, or
 * because the page kept running slow) is saved as a `.cpuprofile` under `.silo/local/profiles/` (silo keeps `local/` out
 * of git: a raw profile is megabytes), and the insights extension says where its time went (`insights.profiles.saved`,
 * extensions/insights/profiles.ts). Only the newest KEEP_PROFILES stay. It's a profile anything can read: DevTools, a
 * desktop profile viewer.
 *
 * Saved as written, not as served: the dev server compiles TypeScript and JSX away and puts its HMR setup and runtime
 * evidence's prelude in front, so each of the app's frames is moved from the preview's address
 * (`/__virtual__/<tab>/<port>/src/Burner`) to its file in the workspace (`file:///workspace/src/Burner.tsx`) and the line
 * and column it's written on, through the served module's inline source map. A module the page imported by an absolute
 * path (`/src/main.ts`) has this origin's address without the prefix (the service worker sends it to the server as the
 * page asked): it's the app's when it's a file in the server's folder. The editor's own frames (a preview shares its
 * thread) are left as they are.
 *
 * Named for its window and when: `5173-1-2026-10-03T12-49-35Z.cpuprofile` (`5173-2-…` for a port's second window).
 */
import type { CpuProfile } from "@brianjenkins94/editor-api/cpuprofile";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { RunRegistry } from "./runs";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/layout";
import { parseVirtual } from "../shared/virtual-path";
import { inlineSourceMap, originalPosition } from "./sourcemap";

/** Where profiles are saved, and how many of the newest stay. */
export const PROFILES = `/workspace/${LOCAL_DIR}/profiles`;
const KEEP_PROFILES = 5;

/** What the shell publishes of a profile it took (shell/preview-profile.ts's PreviewProfiled). */
interface Profiled { "window": string; "port": number; "page": string; "why": "asked" | "slow"; "profile": CpuProfile }

/**
 * `profile` with the app's frames moved to where they're written: each served from the preview on `port` (whose dev
 * server serves `root`, its page at `page`), through its module's source map, which names its source beside the module
 * (`Burner.tsx` for `/src/Burner`), so that's the file, extension and all. A module without one keeps its lines, at its
 * path.
 */
async function sourceMapped(vscode: typeof vscodeApi, profile: CpuProfile, port: number, page: string, root: string): Promise<CpuProfile> {
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
	const prefix = parseVirtual(page)?.prefix;
	const files = new Map<string, Promise<boolean>>();
	const inRoot = (path: string): Promise<boolean> => {
		let found = files.get(path);

		if (found === undefined) {
			found = Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(base + path))).then(() => true, () => false);
			files.set(path, found);
		}

		return found;
	};
	/** A frame's module, as the app's: its path on the server and where to fetch it; else undefined (not the app's). */
	const served = async (url: string): Promise<{ "path": string; "url": string } | undefined> => {
		if (!URL.canParse(url) || new URL(url).origin !== location.origin) {
			return undefined;
		}

		const { pathname } = new URL(url);
		const address = parseVirtual(pathname);

		if (address !== undefined) {
			return address.port === port ? { "path": decodeURIComponent(address.rest), "url": url } : undefined;
		}

		// (imported by an absolute path: its server's when it's a file in the server's folder)
		return prefix !== undefined && await inRoot(decodeURIComponent(pathname)) ? { "path": decodeURIComponent(pathname), "url": location.origin + prefix + pathname } : undefined;
	};

	const nodes = await Promise.all(profile.nodes.map(async (node) => {
		const module = await served(node.callFrame.url);
		const path = module?.path;

		// Not the app's source: the editor's own code, another server's, the page itself, a dependency, the dev server's.
		if (module === undefined || path === undefined || path === "" || path === "/" || path.startsWith("/@") || path.includes("/node_modules/")) {
			return node;
		}

		const map = await mapOf(module.url);
		const original = map === undefined || node.callFrame.lineNumber < 0 ? undefined : originalPosition(map, node.callFrame.lineNumber, Math.max(0, node.callFrame.columnNumber));
		const file = original === undefined ? base + path : base + path.slice(0, path.lastIndexOf("/") + 1) + original.source.replace(/^.*\//u, "");

		return {
			...node,
			"callFrame": {
				...node.callFrame,
				"url": `file://${file}`,
				"lineNumber": original?.line ?? node.callFrame.lineNumber,
				"columnNumber": original?.column ?? node.callFrame.columnNumber
			}
		};
	}));

	return { ...profile, "nodes": nodes };
}

export function installProfileFiles(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry, log: Logger): void {
	hub.subscribe("preview.profiled", (data) => {
		const { port, "window": key, page, why, profile } = (data ?? {}) as Partial<Profiled>;
		const run = typeof port === "number" ? runs.runningService((candidate) => candidate.port === port) : undefined;

		if (run === undefined || port === undefined || profile === undefined || key === undefined) {
			return; // a test's page, or its server has stopped since
		}

		const name = `${key.replace("~", "-")}-${new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z")}.cpuprofile`;
		const uri = vscode.Uri.file(`${PROFILES}/${name}`);

		void log.span("editor.workbench.profile-files.save", { "path": uri.path, "op": why ?? "asked", "count": profile.nodes.length }, async (span) => {
			const moved = await sourceMapped(vscode, profile, port, page ?? "", run.cwd);
			const mapped = JSON.stringify(moved);

			// (local: silo keeps `.silo/local/` out of git)
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(mapped));

			// The newest stay (names end in their time, so they sort by it); the rest go.
			const saved = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(PROFILES))).map(([file]) => file).filter((file) => file.endsWith(".cpuprofile"));
			const stamp = (file: string): string => /\d{4}-\d\d-\d\dT[\d-]+Z/u.exec(file)?.[0] ?? "";
			const old = saved.toSorted((left, right) => stamp(right).localeCompare(stamp(left))).slice(KEEP_PROFILES);

			for (const file of old) {
				await vscode.workspace.fs.delete(vscode.Uri.file(`${PROFILES}/${file}`));
			}

			// (how many of its frames are the app's, where they're written)
			span.end({ "bytes": mapped.length, "removed": old.length, "mapped": moved.nodes.filter((node) => node.callFrame.url.startsWith("file://")).length });
			await vscode.commands.executeCommand("insights.profiles.saved", uri, why ?? "asked");
		}).catch((error: unknown) => {
			log.warn("a preview's profile couldn't be kept", { "path": uri.path, "error": String(error) });
		});
	});
}
