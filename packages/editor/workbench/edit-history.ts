import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { Bablr, EditGroup } from "./bablr";
import { failureText } from "@brianjenkins94/editor-api/failures";
import { serve } from "@brianjenkins94/hub";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/layout";
import { fs } from "@zenfs/core";
import * as engine from "./git-engine";

const DIR = "/workspace";
const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const BURST_IDLE_MS = 600;

interface AutomergeDoc { "text": string }
interface AutomergeApi {
	"init": () => AutomergeDoc;
	"change": (doc: AutomergeDoc, message: string, mutate: (draft: AutomergeDoc) => void) => AutomergeDoc;
	"updateText": (draft: AutomergeDoc, path: string[], value: string) => void;
	"save": (doc: AutomergeDoc) => Uint8Array;
	"load": (bytes: Uint8Array) => AutomergeDoc;
	"getHistory": (doc: AutomergeDoc) => { "change": { "message"?: string; "time": number; "actor": string }; "snapshot": AutomergeDoc }[];
}

let amPromise: Promise<AutomergeApi> | undefined;

async function automerge(): Promise<AutomergeApi> {
	amPromise ??= import("@automerge/automerge") as unknown as Promise<AutomergeApi>;

	return amPromise;
}

const HISTORY = `${DIR}/${LOCAL_DIR}/edit-history`;

async function readHistory(path: string): Promise<Uint8Array | null> {
	try {
		const data = await fs.promises.readFile(`${HISTORY}/${encodeURIComponent(path)}.bin`);

		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	} catch {
		return null;
	}
}

async function writeHistory(path: string, bytes: Uint8Array): Promise<void> {
	await fs.promises.mkdir(HISTORY, { "recursive": true });
	await fs.promises.writeFile(HISTORY + "/" + encodeURIComponent(path) + ".bin", bytes);
}

function repoRelative(uri: vscodeApi.Uri): string | undefined {
	if (uri.scheme !== "file" || !uri.path.startsWith(DIR + "/")) {
		return undefined;
	}

	const path = uri.path.slice(DIR.length + 1);

	return CLASSIFIABLE.test(path)
		? path
		: undefined;
}

export function installEditHistory(vscode: typeof vscodeApi, hub: Hub, bablr: Bablr, log: Logger): void {
	const docs = new Map<string, AutomergeDoc>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	const load = async (path: string): Promise<AutomergeDoc> => {
		const AM = await automerge();
		const saved = await readHistory(path);
		const head = await engine.headContent(path);
		let doc = saved === null
			? undefined
			: AM.load(saved);

		if (doc === undefined || doc.text === head) {
			doc = AM.change(AM.init(), "seed", (draft) => {
				draft.text = head;
			});
		}

		docs.set(path, doc);

		return doc;
	};

	const loading = new Map<string, Promise<AutomergeDoc>>();
	const docFor = async (path: string): Promise<AutomergeDoc> => {
		const existing = docs.get(path);

		if (existing !== undefined) {
			return existing;
		}

		const pending = loading.get(path) ?? load(path);

		loading.set(path, pending);

		try {
			return await pending;
		} finally {
			loading.delete(path);
		}
	};

	const flushNow = async (path: string, text: string): Promise<void> => {
		const AM = await automerge();
		const doc = await docFor(path);

		if (doc.text === text) {
			return;
		}

		const next = AM.change(doc, "burst", (draft) => {
			AM.updateText(draft, ["text"], text);
		});

		docs.set(path, next);

		try {
			await writeHistory(path, AM.save(next));
		} catch (error) {
			log.error("edit-history persist failed", {
				"path": path,
				"error": failureText(error)
			});
		}
	};

	const flushing = new Map<string, Promise<void>>();
	const flush = async (path: string, text: string): Promise<void> => {
		const next = (flushing.get(path) ?? Promise.resolve()).then(async () => flushNow(path, text));

		flushing.set(path, next.catch(() => undefined));

		return next;
	};

	const typing = new Map<string, string>();
	const schedule = (path: string, text: string): void => {
		const pending = timers.get(path);

		if (pending !== undefined) {
			clearTimeout(pending);
		}

		typing.set(path, text);
		timers.set(path, setTimeout(() => {
			timers.delete(path);
			typing.delete(path);
			void flush(path, text).catch((error: unknown) => {
				log.error("edit-history flush failed", {
					"path": path,
					"error": failureText(error)
				});
			});
		}, BURST_IDLE_MS));
	};

	vscode.workspace.onDidChangeTextDocument((event) => {
		const path = repoRelative(event.document.uri);

		if (path !== undefined && event.contentChanges.length > 0) {
			schedule(path, event.document.getText());
		}
	});

	vscode.workspace.onWillSaveTextDocument((event) => {
		const path = repoRelative(event.document.uri);
		const pending = path === undefined
			? undefined
			: timers.get(path);

		if (path !== undefined && pending !== undefined) {
			clearTimeout(pending);
			timers.delete(path);
			typing.delete(path);
			void flush(path, event.document.getText()).catch((error: unknown) => {
				log.error("edit-history will-save flush failed", {
					"path": path,
					"error": failureText(error)
				});
			});
		}
	});

	vscode.workspace.onDidSaveTextDocument((document) => {
		const path = repoRelative(document.uri);

		if (path !== undefined) {
			const pending = timers.get(path);

			if (pending !== undefined) {
				clearTimeout(pending);
				timers.delete(path);
				typing.delete(path);
			}

			void flush(path, document.getText()).catch((error: unknown) => {
				log.error("edit-history save-flush failed", {
					"path": path,
					"error": failureText(error)
				});
			});
		}
	});

	const sinceCommit = async (path: string): Promise<{ "chain": string[]; "lastTime": number }> => {
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

		return {
			"chain": history.slice(base).map((entry) => entry.snapshot.text),
			"lastTime": history.at(-1)?.change.time ?? 0
		};
	};

	serve(hub, "history.chunks", async (args): Promise<{ "groups": EditGroup[]; "bursts": number; "lastTime": number }> => {
		const path = (args as { "path"?: string } | null)?.path;

		if (typeof path !== "string" || !CLASSIFIABLE.test(path)) {
			return { "groups": [], "bursts": 0, "lastTime": 0 };
		}

		return log.span("editor.workbench.edit-history.chunks", { "path": path }, async (span) => {
			const pending = timers.get(path);
			const text = typing.get(path);

			if (pending !== undefined && text !== undefined) {
				clearTimeout(pending);
				timers.delete(path);
				typing.delete(path);
				void flush(path, text).catch(() => undefined);
			}

			await flushing.get(path);

			const { chain, lastTime } = await sinceCommit(path);

			if (chain.length <= 1) {
				return { "groups": [], "bursts": 0, "lastTime": 0 };
			}

			const { groups, bursts } = await bablr.editGroups(chain);

			span.end({ "count": groups.length, "bursts": bursts });

			return { "groups": groups, "bursts": bursts, "lastTime": lastTime };
		});
	});

	log.info("edit history installed");
}
