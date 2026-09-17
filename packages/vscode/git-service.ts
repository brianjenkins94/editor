/**
 * Git service — exposes `git-engine` (+ the cosmetic classifier) over the hub, for the shell's GitHub-Desktop-style
 * review panel to consume. This is a SECOND binding onto the same engine (git-scm.ts is the vscode-SCM one), which
 * is exactly why the engine was kept vscode-free: the novel review UI reads it over the hub without knowing about
 * monaco. Runs in the workbench realm (where zen-fs + the vscode API live); the shell reaches it shell → app →
 * workbench across the hub tree.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { CosmeticClassifier } from "./cosmetic-classifier";
import { serve } from "@brianjenkins94/hub";
import * as engine from "./git-engine";

const DIR = "/workspace";
const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** One changed file as the review panel sees it. */
export interface GitFileChange {
	"path": string;
	"status": "A" | "M" | "D";
	"staged": boolean;
	"unstaged": boolean;
	/** True when a MODIFIED file's change is whitespace/comments only (BABLR verdict); false/undefined otherwise. */
	"cosmetic": boolean;
}

/** Serve `git.status` / `git.file` / `git.commit` and publish `git.changed` on the given hub. */
export function installGitService(vscode: typeof vscodeApi, hub: Hub, classifier: CosmeticClassifier, log: Logger): void {
	const readWorking = async (path: string): Promise<string> =>
		new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	serve(hub, "git.status", async () => {
		const status = await engine.status();
		const byPath = new Map<string, GitFileChange>();

		const record = (change: engine.GitChange, kind: "staged" | "unstaged"): void => {
			let entry = byPath.get(change.path);

			if (entry === undefined) {
				entry = { "path": change.path, "status": change.status, "staged": false, "unstaged": false, "cosmetic": false };
				byPath.set(change.path, entry);
			}

			entry[kind] = true;
			entry.status = change.status;
		};

		for (const change of status.staged) {
			record(change, "staged");
		}

		for (const change of status.unstaged) {
			record(change, "unstaged");
		}

		// Cosmetic verdict for modified, classifiable files (off-thread + cached in the classifier).
		await Promise.all([...byPath.values()].map(async (entry) => {
			if (entry.status === "M" && CLASSIFIABLE.test(entry.path)) {
				try {
					entry.cosmetic = (await classifier.classify(await engine.headContent(entry.path), await readWorking(entry.path))) === "cosmetic";
				} catch { /* unreadable / unparsable → no badge */ }
			}
		}));

		return { "files": [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
	});

	serve(hub, "git.file", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;

		if (typeof path !== "string") {
			return { "head": "", "working": "", "verdict": "none" };
		}

		let working = "";

		try {
			working = await readWorking(path);
		} catch { /* deleted in the working tree */ }

		// Fast path — no BABLR here (it's slow); the shell asks for the verdict separately via git.classify.
		return { "head": await engine.headContent(path), "working": working };
	});

	// BABLR verdict for the whole change, requested LAZILY after the diff is shown so BABLR never blocks the open.
	// Only meaningful for a MODIFIED code file — added/deleted/non-code return "none". Only ONE diff is open at a time,
	// so a new request SUPERSEDES the previous: we abort the older run (the yielding worker bails cooperatively).
	let classifyInFlight: AbortController | undefined;

	// A CORRECT, content-addressed cache: keyed by (baseOid, headOid, working blob oid) — all git content hashes, so a
	// hit means genuinely identical inputs (this is the identity-based cache the commit-chain design bought us; it
	// replaces the approximate caches we removed). Bounded so a long session can't grow it without limit.
	interface ClassifyResult { "verdict": string; "changedNodeIds": string[]; "changedLines": number[]; "baseOid": string | null }
	const classifyCache = new Map<string, ClassifyResult>();

	serve(hub, "git.classify", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;

		if (typeof path !== "string" || !CLASSIFIABLE.test(path)) {
			return { "verdict": "none" };
		}

		let working = "";

		try {
			working = await readWorking(path);
		} catch { /* deleted */ }

		const head = await engine.headContent(path);

		if (head === "" || working === "") {
			return { "verdict": "none" };
		}

		const { baseOid, headOid, contents } = await engine.fileHistory(path);
		const cacheKey = path + "\0" + baseOid + "\0" + headOid + "\0" + await engine.blobOid(working);
		const cached = classifyCache.get(cacheKey);

		if (cached !== undefined) {
			return cached; // exact same inputs (by content hash) — the derivation is deterministic, so reuse it
		}

		classifyInFlight?.abort();
		const controller = new AbortController();

		classifyInFlight = controller;

		try {
			// Anchor identity in REAL history: derive over [base…HEAD, working]. The `.bablr` snapshot carries
			// HISTORY-ANCHORED node ids; the verdict is HEAD→working (the last two links).
			const result = await classifier.identify([...contents, working], controller.signal);

			if (result.snapshot !== null) {
				await engine.writeBablr(path, JSON.stringify({ "path": path, "baseOid": baseOid, "verdict": result.verdict, "changedNodeIds": result.changedNodeIds, "snapshot": result.snapshot }));
			}

			const answer: ClassifyResult = { "verdict": result.verdict, "changedNodeIds": result.changedNodeIds, "changedLines": result.changedLines, "baseOid": baseOid };

			if (classifyCache.size > 200) {
				classifyCache.clear();
			}

			classifyCache.set(cacheKey, answer);

			return answer;
		} catch {
			return { "verdict": "none" }; // aborted (superseded) or worker error — the newer request will answer
		} finally {
			if (classifyInFlight === controller) {
				classifyInFlight = undefined;
			}
		}
	});

	// Annotation store — user data pinned to derivable NODE IDS (from the .bablr snapshot), so it follows a line as
	// it moves without shipping the CST. Read one file's map, or set/clear one node's annotation.
	serve(hub, "annotations.get", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;

		return { "annotations": typeof path === "string" ? await engine.readAnnotations(path) : {} };
	});

	serve(hub, "annotations.set", async (args) => {
		const request = args as { "path"?: string; "nodeId"?: string; "value"?: unknown } | null;

		if (typeof request?.path !== "string" || typeof request.nodeId !== "string") {
			throw new Error("annotations.set needs a path and nodeId.");
		}

		await engine.setAnnotation(request.path, request.nodeId, request.value ?? null);

		return { "ok": true };
	});

	serve(hub, "git.commit", async (args) => {
		const request = args as { "message"?: string; "files"?: engine.CommitFile[] } | null;
		const message = request?.message?.trim();

		if (message === undefined || message === "") {
			throw new Error("Enter a commit message first.");
		}

		// `files` present → selective commit (the shell's checkbox / line selection); absent → legacy commit-all.
		const oid = request?.files !== undefined
			? await engine.commitSelection(message, request.files)
			: await engine.commitAll(message);

		hub.publish("git.changed");
		log.info("git commit (service)", { "oid": oid.slice(0, 7), "files": request?.files?.length });

		return { "oid": oid };
	});

	// Discard a file's working-tree changes: whole file (restore HEAD / delete), or a PARTIAL discard when the shell
	// sends the exact post-discard `content` (working with the chosen hunks reverted).
	serve(hub, "git.discard", async (args) => {
		const request = args as { "path"?: string; "content"?: string } | null;

		if (typeof request?.path !== "string") {
			throw new Error("git.discard needs a path.");
		}

		if (typeof request.content === "string") {
			await engine.setWorking(request.path, request.content);
		} else {
			await engine.discardFile(request.path);
		}

		hub.publish("git.changed");

		return { "ok": true };
	});

	// Tell the shell to refresh when the working tree changes (saves, and picker-driven writes).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => { hub.publish("git.changed"); }, 300);
	};

	vscode.workspace.onDidSaveTextDocument(schedule);

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	watcher.onDidDelete(schedule);

	log.info("git service installed");
}
