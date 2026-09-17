/**
 * Edit-history — the FINE-GRAINED local tier of the two-tier history (Automerge = live edits, git = published commits).
 * Git only ever sees the saved snapshot; this records the sequence of edit-bursts BETWEEN commits into a per-file
 * Automerge doc, so the changes pane can show "the changes you introduced" as small, attributable chunks instead of
 * one monolithic diff.
 *
 * CAPTURE (this module, workbench realm): coalesce keystrokes into idle-debounced BURSTS; each burst is one
 * `Automerge.change` on a doc holding the file text. Lossless + append-only — grouping into meaningful units happens
 * at DISPLAY time (by BABLR node), so the capture format never has to commit to a grouping. Persisted per file as the
 * `Automerge.save` binary under `.git/` (via the engine), so it survives reload; the synced version is the Keyhive
 * milestone. Automerge (WASM) is lazily imported so its weight never lands on cold start.
 *
 * BASELINE ("since the last commit"): the doc is seeded with the HEAD text as its first change, so the most recent
 * history entry whose snapshot equals current HEAD marks the last commit — chunks are everything after it. This
 * self-corrects on commit (the committed text becomes the latest snapshot, so the list empties) with nothing to store.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { CosmeticClassifier } from "./cosmetic-classifier";
import { serve } from "@brianjenkins94/hub";
import * as engine from "./git-engine";

const DIR = "/workspace";
const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const BURST_IDLE_MS = 600;

// Lazily loaded Automerge (base64-inlined WASM build — see build.ts alias). Typed loosely: we use a small slice.
interface AutomergeDoc { "text": string }
interface AutomergeApi {
	"init": () => AutomergeDoc;
	"change": (doc: AutomergeDoc, message: string, mutate: (draft: AutomergeDoc) => void) => AutomergeDoc;
	"updateText": (draft: AutomergeDoc, path: string[], value: string) => void;
	"save": (doc: AutomergeDoc) => Uint8Array;
	"load": (bytes: Uint8Array) => AutomergeDoc;
	"getHistory": (doc: AutomergeDoc) => { "change": { "message"?: string; "time": number; "actor": string }; "snapshot": AutomergeDoc }[];
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
let amPromise: Promise<AutomergeApi> | undefined;
const automerge = async (): Promise<AutomergeApi> => {
	amPromise ??= import("@automerge/automerge") as unknown as Promise<AutomergeApi>;

	return amPromise;
};

/** Repo-relative path for a classifiable workspace file, else undefined. */
function repoRelative(uri: vscodeApi.Uri): string | undefined {
	if (uri.scheme !== "file" || !uri.path.startsWith(DIR + "/")) {
		return undefined;
	}

	const path = uri.path.slice(DIR.length + 1);

	return CLASSIFIABLE.test(path) ? path : undefined;
}

export function installEditHistory(vscode: typeof vscodeApi, hub: Hub, classifier: CosmeticClassifier, log: Logger): void {
	// Per-file in-memory doc + its pending-flush timer. The doc is the source of truth; the binary on disk is a mirror.
	const docs = new Map<string, AutomergeDoc>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	// Get (or lazily create) the Automerge doc for a path: load the persisted binary, else seed from HEAD text.
	const docFor = async (path: string): Promise<AutomergeDoc> => {
		const existing = docs.get(path);

		if (existing !== undefined) {
			return existing;
		}

		const AM = await automerge();
		const saved = await engine.readAutomerge(path);
		let doc: AutomergeDoc;

		if (saved !== null) {
			doc = AM.load(saved);
		} else {
			const head = await engine.headContent(path);

			doc = AM.change(AM.init(), "seed", (draft) => { draft.text = head; });
		}

		docs.set(path, doc);

		return doc;
	};

	// Flush the current editor text as ONE burst (no-op when the text is unchanged from the doc's latest snapshot).
	const flush = async (path: string, text: string): Promise<void> => {
		const AM = await automerge();
		const doc = await docFor(path);

		if (doc.text === text) {
			return;
		}

		const next = AM.change(doc, "burst", (draft) => { AM.updateText(draft, ["text"], text); });

		docs.set(path, next);

		try {
			await engine.writeAutomerge(path, AM.save(next));
		} catch (error) {
			log.error("edit-history persist failed", { "path": path, "error": errText(error) });
		}
	};

	const schedule = (path: string, text: string): void => {
		const pending = timers.get(path);

		if (pending !== undefined) {
			clearTimeout(pending);
		}

		timers.set(path, setTimeout(() => {
			timers.delete(path);
			void flush(path, text).catch((error: unknown) => { log.error("edit-history flush failed", { "path": path, "error": errText(error) }); });
		}, BURST_IDLE_MS));
	};

	vscode.workspace.onDidChangeTextDocument((event) => {
		const path = repoRelative(event.document.uri);

		if (path !== undefined && event.contentChanges.length > 0) {
			schedule(path, event.document.getText());
		}
	});

	// A save is a natural burst boundary — flush immediately so the timeline lines up with what's on disk.
	vscode.workspace.onDidSaveTextDocument((document) => {
		const path = repoRelative(document.uri);

		if (path !== undefined) {
			const pending = timers.get(path);

			if (pending !== undefined) {
				clearTimeout(pending);
				timers.delete(path);
			}

			void flush(path, document.getText()).catch((error: unknown) => { log.error("edit-history save-flush failed", { "path": path, "error": errText(error) }); });
		}
	});

	// The "your edits" timeline: the reviewer's uncommitted work SINCE the last commit, decomposed into node-grouped
	// chunks. Base = the LAST history snapshot equal to current HEAD (self-resets on commit); the burst chain from there
	// [HEAD, …afters] is fed to the identity core (off-thread), which returns the net-changed nodes + their line ranges.
	serve(hub, "history.chunks", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;

		if (typeof path !== "string" || !CLASSIFIABLE.test(path)) {
			return { "groups": [], "bursts": 0, "lastTime": 0 };
		}

		const AM = await automerge();
		const doc = await docFor(path);
		const head = await engine.headContent(path);
		const history = AM.getHistory(doc);

		let base = 0;

		for (let index = 0; index < history.length; index += 1) {
			if (history[index].snapshot.text === head) {
				base = index;
			}
		}

		if (base >= history.length - 1) {
			return { "groups": [], "bursts": 0, "lastTime": 0 }; // nothing since the last commit
		}

		// [HEAD, …burst afters] — the last entry is the current working text, so line ranges land in working coords.
		const chain = history.slice(base).map((entry) => entry.snapshot.text);
		const { groups, bursts } = await classifier.editGroups(chain);

		return { "groups": groups, "bursts": bursts, "lastTime": history[history.length - 1].change.time };
	});

	log.info("edit history installed");
}
