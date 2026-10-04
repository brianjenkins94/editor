/**
 * What running your program teaches the editor, kept in git (RUNTIME-EVIDENCE.md): when a run ends, its envelope —
 * whose run, where it ran, on what code — is appended to `.silo/runs/<user>.jsonl`, and what it observed is folded into
 * `.silo/evidence/<user>/<environment>/<file>.jsonl`, keyed on BABLR spans. silo decides the shape, the layout and how
 * evidence fades (@brianjenkins94/util/silo/evidence); this gathers the facts only the editor has: the run (runs.ts), the
 * browser it ran in, the repo it ran on, and what the runtimes saw — so far a debug session's coverage
 * (`evidence.coverage`, from the tsval adapter), each statement keyed by the spanAnchors id the BABLR worker finds
 * for it. A file BABLR's grammar doesn't take yet gets no evidence; its run is still recorded.
 *
 * Runs in the workbench realm; writes through VS Code's file system, so an open runs file shows each new line.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { Environment, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import type { StatementCoverage } from "./extensions/worker-pod/debug-protocol";
import type { Bablr } from "./bablr";
import type { RunInfo, RunRegistry } from "./runs";
import { envelopeLine, evidencePath, evidenceText, foldReached, GITATTRIBUTES, GITIGNORE, parseEvidence, runsPath, SILO_DIR, userSlug } from "@brianjenkins94/util/silo/evidence";
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

/** A run's coverage of the program it ran: the source that ran, and each statement's range in it with its count. */
interface Coverage { "file": string; "source": string; "statements": StatementCoverage[] }

/** Each statement's range in `source` as offsets (its line/character positions, counted in UTF-16 code units). */
function offsets(source: string, statements: StatementCoverage[]): { "start": number; "end": number }[] {
	const lineStarts = [0];

	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
		lineStarts.push(index + 1);
	}

	const at = ([line, character]: [number, number]): number => (lineStarts[line] ?? source.length) + character;

	return statements.map((statement) => ({ "start": at(statement.start), "end": at(statement.end) }));
}

let siloFiles: Promise<void> | undefined;

/**
 * `.silo/`'s own two files, before anything is written into it: `.gitignore` (silo's GITIGNORE — `local/` stays on this
 * machine) and `.gitattributes` (silo's GITATTRIBUTES — its JSONL merges by line). Lines already there are kept. Once a
 * session; profile-files.ts calls it too, since a profile can be the first thing saved there.
 */
export async function ensureSiloFiles(vscode: typeof vscodeApi): Promise<void> {
	siloFiles ??= (async () => {
		for (const [name, wanted] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]] as const) {
			const uri = vscode.Uri.file(`${ROOT}/${SILO_DIR}/${name}`);
			const existing = await vscode.workspace.fs.readFile(uri).then((bytes) => new TextDecoder().decode(bytes), () => "");
			const missing = wanted.split("\n").filter((line) => line !== "" && !existing.split(/\r?\n/u).includes(line));

			if (missing.length > 0) {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode((existing === "" || existing.endsWith("\n") ? existing : existing + "\n") + missing.join("\n") + "\n"));
			}
		}
	})().catch(() => { siloFiles = undefined; });

	return siloFiles;
}

/** `path` relative to the workspace (the repo root). */
function repoRelative(path: string): string {
	return path.startsWith(ROOT + "/") ? path.slice(ROOT.length + 1) : path === ROOT ? "." : path;
}

export function installEvidence(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry, bablr: Bablr): void {
	// Each run's coverage, until the run ends (the session's coverage comes just before its end).
	const coverage = new Map<string, Coverage>();

	hub.subscribe("evidence.coverage", (data) => {
		const { runId, ...rest } = (data ?? {}) as Coverage & { "runId"?: unknown };

		if (typeof runId === "string" && typeof rest.source === "string" && Array.isArray(rest.statements)) {
			coverage.set(runId, rest);
		}
	});

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
		const covered = coverage.get(run.id);

		coverage.delete(run.id);

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

		// The code a session ran is the source it was given, whatever the file holds now.
		if (covered !== undefined) {
			envelope.files[repoRelative(covered.file)] = await blobOid(covered.source);
		}

		const path = runsPath(envelope.user);
		const before = await read(path) ?? new Uint8Array();

		await ensureSiloFiles(vscode);
		await vscode.workspace.fs.writeFile(uri(path), new Uint8Array([...before, ...new TextEncoder().encode(envelopeLine(envelope))]));

		if (covered !== undefined) {
			await recordCoverage(envelope, covered);
		}
	};

	/** A run's coverage, keyed on spans, folded into what earlier runs in its environment observed of the file. */
	const recordCoverage = async (envelope: RunEnvelope, covered: Coverage): Promise<void> => {
		if (covered.source === "") {
			return; // BABLR has nothing to parse
		}

		const ids = await bablr.anchors(covered.source, offsets(covered.source, covered.statements));

		if (ids === undefined) {
			return; // BABLR's grammar doesn't take this file yet
		}

		const reached = covered.statements.flatMap((statement, index) => {
			const span = ids[index];

			return typeof span === "string" ? [{ "span": span, "count": statement.count }] : [];
		});
		const path = evidencePath(envelope.user, envelope.environment, repoRelative(covered.file));
		const known = parseEvidence(new TextDecoder().decode(await read(path) ?? new Uint8Array()));

		await vscode.workspace.fs.writeFile(uri(path), new TextEncoder().encode(evidenceText(foldReached(known, reached, { "id": envelope.id, "at": envelope.endedAt }))));
	};

	runs.onEnd((run) => {
		writing = writing.then(async () => record(run)).catch(() => { /* evidence never breaks a run */ });
	});
}
