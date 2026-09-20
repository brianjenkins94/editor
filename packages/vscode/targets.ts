/**
 * Run targets — the set of runnable things a repo exposes, discovered from its package.json(s). A repo isn't one
 * runnable: it has scripts (dev/build/test/…), bins (CLIs), and in a monorepo all of those per package. This
 * enumerates them so the shell's run picker can offer a choice, and runs the chosen one in a terminal — which,
 * because every launch goes through our just-bash shell (the ambient run-minter), gets bracketed + recorded in the
 * `.silo/` run ledger with its `target` identity, no explicit `silo run` needed.
 *
 * Runs in the workbench realm (zen-fs + the vscode API live here). The shell reaches it over the hub:
 *   shell → `targets.list` (RPC) → the discovered targets
 *   shell → `run.target` { command, cwd, name } → run it in a fresh terminal (our bash process)
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import { serve } from "@brianjenkins94/hub";

const WORKSPACE = "/workspace";

/** One runnable a repo exposes. `id` is a stable identity (matches the run-record `target`); `cwd` is where to run. */
export interface RunTarget {
	"id": string;
	/** Repo-relative package dir: "." for the root, "packages/web" for a nested package. */
	"package": string;
	"kind": "script" | "bin";
	"name": string;
	/** The shell command to run (e.g. `npm run dev`). */
	"command": string;
	/** Absolute cwd (e.g. `/workspace` or `/workspace/packages/web`). */
	"cwd": string;
}

/** A package dir → its repo-relative identity ("." for the root). */
function repoRelativeDir(absDir: string): string {
	return absDir.replace(/^\/workspace\/?/u, "") || ".";
}

async function readManifest(vscode: typeof vscodeApi, uri: vscodeApi.Uri): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as Record<string, unknown>;
	} catch {
		return undefined; // absent / malformed
	}
}

/** Enumerate every runnable: each package.json's scripts + bins, across the workspace (monorepo → per package). */
export async function discoverTargets(vscode: typeof vscodeApi): Promise<RunTarget[]> {
	let manifests: vscodeApi.Uri[];

	try {
		manifests = await vscode.workspace.findFiles("**/package.json", "**/node_modules/**");
	} catch {
		manifests = [vscode.Uri.file(WORKSPACE + "/package.json")]; // findFiles unavailable → at least the root
	}

	const targets: RunTarget[] = [];

	for (const uri of manifests) {
		const pkg = await readManifest(vscode, uri);

		if (pkg === undefined) {
			continue;
		}

		const dir = uri.path.replace(/\/package\.json$/u, "") || WORKSPACE;
		const pkgRel = repoRelativeDir(dir);
		const scripts = typeof pkg["scripts"] === "object" && pkg["scripts"] !== null ? pkg["scripts"] as Record<string, string> : {};

		for (const name of Object.keys(scripts)) {
			targets.push({ "id": `${pkgRel}:script:${name}`, "package": pkgRel, "kind": "script", "name": name, "command": `npm run ${name}`, "cwd": dir });
		}

		const bin = pkg["bin"];

		if (typeof bin === "string") {
			const name = typeof pkg["name"] === "string" ? pkg["name"] : pkgRel;

			targets.push({ "id": `${pkgRel}:bin:${name}`, "package": pkgRel, "kind": "bin", "name": name, "command": `node ${bin}`, "cwd": dir });
		} else if (typeof bin === "object" && bin !== null) {
			for (const [name, path] of Object.entries(bin as Record<string, string>)) {
				targets.push({ "id": `${pkgRel}:bin:${name}`, "package": pkgRel, "kind": "bin", "name": name, "command": `node ${path}`, "cwd": dir });
			}
		}
	}

	targets.sort((a, b) => (a.package + a.kind + a.name).localeCompare(b.package + b.kind + b.name));

	return targets;
}

/** Serve `targets.list` and run a chosen `run.target` in a fresh terminal (our bash process mints + records it). */
export function installRunTargets(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	serve(hub, "targets.list", async () => ({ "targets": await discoverTargets(vscode) }));

	hub.subscribe("run.target", (data) => {
		const request = data as { "command"?: string; "cwd"?: string; "name"?: string };

		if (typeof request.command !== "string") {
			return;
		}

		const command = request.command;

		void (async () => {
			try {
				// `createTerminal({options})` is NotSupported in this vendored build, so open a fresh terminal via the
				// workbench command (a new one per run → concurrent runs each get their own), falling back to an
				// existing terminal if that's unavailable.
				try {
					await vscode.commands.executeCommand("workbench.action.terminal.new");
				} catch { /* fall back to whatever terminal exists */ }

				const terminal = vscode.window.activeTerminal ?? vscode.window.terminals[0];

				if (terminal === undefined) {
					log.error("run target: no terminal available");

					return;
				}

				terminal.show();

				// cwd is set inline (`cd … && …`) since we can't pass it to the terminal; a single line runs in that
				// dir. sendText runs it through our bash process, which brackets + records the run.
				const cwd = typeof request.cwd === "string" ? request.cwd : "";
				const line = cwd !== "" && cwd !== "/workspace" ? `cd ${cwd} && ${command}` : command;

				setTimeout(() => { terminal.sendText(line); }, 200);
			} catch (error) {
				log.error("run target failed", { "error": String(error) });
			}
		})();
	});

	log.info("run targets service installed");
}
