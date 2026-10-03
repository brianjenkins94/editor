/**
 * What running your program teaches the editor, kept in git (RUNTIME-EVIDENCE.md): when a run ends, its envelope —
 * whose run, where it ran, on what code — is appended to `.silo/runs/<user>.jsonl`. What it observed (coverage, time,
 * values, capabilities) joins it by its run id. silo decides the shape and the layout (@brianjenkins94/util/silo/evidence);
 * this gathers the facts only the editor has: the run (runs.ts), the browser it ran in, the repo it ran on.
 *
 * Runs in the workbench realm; writes through VS Code's file system, so an open runs file shows each new line.
 */
import type * as vscodeApi from "vscode";
import type { Environment, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import type { RunInfo, RunRegistry } from "./runs";
import { envelopeLine, runsPath, userSlug } from "@brianjenkins94/util/silo/evidence";
import { blobOid, headCommit } from "./git-engine";

const ROOT = "/workspace";

interface UserAgentData { "brands"?: { "brand": string; "version": string }[]; "platform"?: string }

/** The browser this tab runs in, as silo's environment class: engine and major version, OS family, cores, memory. */
function browserClass(): Omit<Environment, "runtime" | "name"> {
	const agent = (navigator as Navigator & { "userAgentData"?: UserAgentData }).userAgentData;
	const ua = navigator.userAgent;
	const chromium = agent?.brands?.find((brand) => brand.brand === "Chromium")?.version ?? /Chrom(?:e|ium)\/(\d+)/u.exec(ua)?.[1];
	const firefox = /Firefox\/(\d+)/u.exec(ua)?.[1];
	const safari = /Version\/(\d+).*Safari/u.exec(ua)?.[1];
	const engine = chromium !== undefined ? `chromium-${chromium}` : firefox !== undefined ? `firefox-${firefox}` : safari !== undefined ? `webkit-${safari}` : "unknown";
	const platform = (agent?.platform ?? navigator.platform ?? "").toLowerCase();
	const os = /android/u.test(ua.toLowerCase()) ? "android" : /iphone|ipad/u.test(ua.toLowerCase()) ? "ios" : platform.startsWith("mac") ? "macos" : platform.startsWith("win") ? "windows" : platform.includes("linux") ? "linux" : "unknown";
	const memory = (navigator as Navigator & { "deviceMemory"?: number }).deviceMemory;

	return { "engine": engine, "os": os, "cores": navigator.hardwareConcurrency, ...memory === undefined ? {} : { "memoryGb": memory } };
}

/** `path` relative to the workspace (the repo root). */
function repoRelative(path: string): string {
	return path.startsWith(ROOT + "/") ? path.slice(ROOT.length + 1) : path === ROOT ? "." : path;
}

export function installEvidence(vscode: typeof vscodeApi, runs: RunRegistry): void {
	const uri = (path: string): vscodeApi.Uri => vscode.Uri.file(`${ROOT}/${path}`);
	const read = async (path: string): Promise<Uint8Array | undefined> => {
		try {
			return await vscode.workspace.fs.readFile(uri(path));
		} catch {
			return undefined;
		}
	};
	let user: Promise<string> | undefined;
	// Who you are to git, read once: the repo's own config names you (a slug of your email); `local` until it does.
	const currentUser = async (): Promise<string> => {
		user ??= read(".git/config").then((config) => (config === undefined ? undefined : userSlug(new TextDecoder().decode(config))) ?? "local");

		return user;
	};

	// One write at a time: each appends to the file the last one wrote.
	let writing = Promise.resolve();

	const record = async (run: RunInfo): Promise<void> => {
		const entry = repoRelative(run.entry ?? run.cwd);
		const source = run.entry === undefined ? undefined : await read(entry);
		const name = vscode.workspace.getConfiguration("silo").get<string>("machine")?.trim();
		const envelope: RunEnvelope = {
			"type": "run",
			"id": run.id,
			"title": run.title,
			"entry": entry,
			"cwd": repoRelative(run.cwd),
			"startedAt": new Date(run.startedAt).toISOString(),
			"endedAt": new Date(run.endedAt ?? Date.now()).toISOString(),
			"exit": run.exitCode ?? 0,
			...run.state === "stopped" ? { "stopped": true as const } : {},
			"user": await currentUser(),
			"environment": { "runtime": run.runtime ?? "almostnode", ...browserClass(), "name": name === undefined || name === "" ? "default" : name },
			...await headCommit().then((commit) => (commit === undefined ? {} : { "commit": commit })),
			"files": source === undefined ? {} : { [entry]: await blobOid(new TextDecoder().decode(source)) }
		};
		const path = runsPath(envelope.user);
		const before = await read(path) ?? new Uint8Array();

		await vscode.workspace.fs.writeFile(uri(path), new Uint8Array([...before, ...new TextEncoder().encode(envelopeLine(envelope))]));
	};

	runs.onEnd((run) => {
		writing = writing.then(async () => record(run)).catch(() => { /* evidence never breaks a run */ });
	});
}
