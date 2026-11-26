import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger, Span } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import * as engine from "./git-engine";

const DIR = "/workspace";

const MOST_EDITS = 5000;

export function unifiedDiff(path: string, before: string, after: string): string {
	if (before === after) {
		return "";
	}

	const [from, to] = [before === "" ? "/dev/null" : `a/${path}`, after === "" ? "/dev/null" : `b/${path}`];
	const patch = structuredPatch(from, to, before, after, undefined, undefined, { "context": 3, "maxEditLength": MOST_EDITS });

	return patch === undefined ? `--- ${from}\n+++ ${to}\n(more than ${MOST_EDITS} lines differ)\n` : formatPatch(patch, FILE_HEADERS_ONLY);
}

export interface CommitPick { "path": string; "hunks"?: string[]; "except"?: number[] }

export interface GitReader {
	"status": (options?: { "whole"?: boolean }) => Promise<{ "files": GitFileChange[]; "head"?: string }>;
	"file": (path: unknown) => Promise<{ "head": string; "working": string }>;
}

export type CommitPart = (pick: CommitPick, whole: engine.CommitFile, file: GitReader["file"]) => Promise<engine.CommitFile | undefined>;

export type BeforeCommit = (span: Span) => Promise<string | undefined>;

export interface GitService extends GitReader { "beforeCommit": (step: BeforeCommit) => void }

export function installGitService(vscode: typeof vscodeApi, hub: Hub, log: Logger, { part }: { "part"?: CommitPart } = {}): GitService {
	const readWorking = async (path: string): Promise<string> => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	let changedSince: Set<string> | undefined;

	const walk = async (whole: boolean): Promise<{ "files": GitFileChange[]; "head"?: string }> => log.span("editor.workbench.git-service.walk", { "whole": whole }, async (span) => {
		const changed = whole || changedSince === undefined ? undefined : [...changedSince];

		changedSince = new Set();
		span.info("walking", { "count": changed?.length ?? -1 });

		const current = await engine.status(changed);
		const byPath = new Map<string, GitFileChange>();

		const record = (change: engine.GitChange, kind: "staged" | "unstaged"): void => {
			let entry = byPath.get(change.path);

			if (entry === undefined) {
				entry = { "path": change.path, "status": change.status, "staged": false, "unstaged": false };
				byPath.set(change.path, entry);
			}

			entry[kind] = true;
			entry.status = change.status;
		};

		for (const change of current.staged) {
			record(change, "staged");
		}

		for (const change of current.unstaged) {
			record(change, "unstaged");
		}

		const head = await engine.headCommit();

		if (!await engine.siloCommitted()) {
			for (const entry of byPath.values()) {
				if (entry.path.startsWith(".silo/")) {
					entry.offered = false;
				}
			}
		}

		span.end({ "count": byPath.size });

		return { "files": [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)), ...head === undefined ? {} : { "head": head } };
	});

	let changes = 0;
	let walking: { "since": number; "whole": boolean; "result": Promise<{ "files": GitFileChange[]; "head"?: string }> } | undefined;

	const status = async ({ whole = false }: { "whole"?: boolean } = {}): Promise<{ "files": GitFileChange[]; "head"?: string }> => {
		if (walking?.since === changes && (walking.whole || !whole)) {
			return walking.result;
		}

		const result = walk(whole);
		const current = { "since": changes, "whole": whole, "result": result };

		walking = current;
		void result.finally(() => {
			if (walking === current) {
				walking = undefined;
			}
		}).catch(() => undefined);

		return result;
	};

	serve(hub, "git.status", async (args) => status({ "whole": (args as { "whole"?: boolean } | null | undefined)?.whole === true }));
	vscode.commands.registerCommand("editor.git.status", async () => status());

	const file = async (path: unknown): Promise<{ "head": string; "working": string }> => {
		if (typeof path !== "string") {
			return { "head": "", "working": "" };
		}

		let working = "";

		try {
			working = await readWorking(path);
		} catch { /* deleted in the working tree */ }

		return { "head": await engine.headContent(path), "working": working };
	};

	serve(hub, "git.file", async (args) => file((args as { "path"?: string } | null)?.path));
	vscode.commands.registerCommand("editor.git.file", file);

	const toCommit = async (pick: CommitPick, changes: ReadonlyMap<string, GitFileChange>): Promise<engine.CommitFile | undefined> => {
		const change = changes.get(pick.path);

		if (change === undefined) {
			throw new Error(`${pick.path} has no change to commit`);
		}

		const whole = { "path": pick.path, ...change.status === "D" ? { "deleted": true } : {} };

		if (pick.hunks === undefined && pick.except === undefined) {
			return whole;
		}

		if (part === undefined) {
			throw new Error(`a commit of part of ${pick.path} is the review's, which isn't here`);
		}

		return part(pick, whole, file);
	};

	let before: BeforeCommit | undefined;

	const tested = async (): Promise<string | undefined> => {
		const step = before;

		return step === undefined ? undefined : log.span("editor.workbench.git-service.test", {}, async (span) => step(span)).catch((error: unknown) => `The tests a commit runs first didn't run: ${error instanceof Error ? error.message : String(error)}`);
	};

	const commit = async (request: { "message"?: string; "files"?: CommitPick[] } | null): Promise<engine.Committed & { "tests"?: string }> => {
		const message = request?.message?.trim();

		if (message === undefined || message === "") {
			throw new Error("Enter a commit message first.");
		}

		let made: engine.Committed;

		changes += 1;

		const tests = await tested();

		if (request?.files === undefined) {
			const unoffered = new Set((await status({ "whole": true })).files.filter((change) => change.offered === false).map((change) => change.path));

			made = await engine.commitAll(message, (path) => unoffered.has(path));
		} else {
			const changes = new Map((await status({ "whole": true })).files.map((change) => [change.path, change]));
			const picked = await Promise.all(request.files.map(async (pick) => toCommit(pick, changes)));

			made = await engine.commitSelection(message, picked.filter((each) => each !== undefined));
		}

		changes += 1;
		hub.publish("git.changed");
		log.info("git commit (service)", { "oid": made.oid.slice(0, 7), "files": request?.files?.length });

		return { ...made, ...tests === undefined ? {} : { "tests": tests } };
	};

	serve(hub, "git.commit", async (args) => commit(args));
	vscode.commands.registerCommand("editor.git.commit", async (message: unknown) => commit({ "message": typeof message === "string" ? message : undefined }));

	const shell = createRpcClient(hub);

	const identity = async (): Promise<{ "name": string; "email": string } | undefined> => {
		try {
			const who = await shell.request("git.identity", undefined, { "timeoutMs": 30_000 }) as { "name": string; "email": string } | null ?? undefined;

			if (who !== undefined) {
				await engine.recordIdentity(who).catch((error: unknown) => {
					log.warn("couldn't write who you are to the workspace's git config", { "error": error instanceof Error ? error.message : String(error) });
				});
			}

			return who;
		} catch (error) {
			log.warn("who a commit is by: unknown, so it's the placeholder's", { "error": error instanceof Error ? error.message : String(error) });

			return undefined;
		}
	};

	engine.setAuthor(identity);
	void identity();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (changed?: { "uri": { "path": string } } | { "path": string }): void => {
		changes += 1;

		const path = changed === undefined ? undefined : "uri" in changed ? changed.uri.path : changed.path;

		if (path?.startsWith(DIR + "/") === true) {
			changedSince?.add(path.slice(DIR.length + 1));
		} else {
			changedSince = undefined;
		}

		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			hub.publish("git.changed");
		}, 300);
	};

	vscode.workspace.onDidSaveTextDocument(schedule);

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	watcher.onDidDelete(schedule);

	log.info("git service installed");

	void engine.ensureRepo().then(() => {
		hub.publish("git.changed");
	}, (error: unknown) => {
		const thrown = error as Error | string | number | boolean | null | undefined;

		log.error("git repository unavailable", { "error": thrown instanceof Error ? thrown.message : String(thrown) });
	});

	return {
		"status": status,
		"file": file,
		"beforeCommit": (step) => {
			before = step;
		}
	};
}
