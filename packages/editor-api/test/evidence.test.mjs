// The runtime evidence kept for a file (evidence.ts), as the insights surfaces read it: every user's runs in every
// environment folded together with this machine's samples, placed where its spans are in the file now, every file that
// has some, and read again when it changes. Through a stand-in for the extension API: the workspace's files in memory,
// and the bridge's `editor.annotations.resolve` answering where each span is.
import * as assert from "node:assert/strict";
import { test } from "node:test";

import { evidenceStore } from "../src/evidence.ts";

const line = (observation) => JSON.stringify(observation) + "\n";

/** The extension API as evidenceStore uses it, over `files` (absolute path → text); `where` answers resolve for each
 *  span id, or `"unparsable"`. */
function standIn(files, where) {
	const uri = (path) => ({ "path": path, "scheme": "file", "toString": () => `file://${path}` });

	class EventEmitter {
		listeners = [];

		event = (listener) => {
			this.listeners.push(listener);

			return { "dispose": () => undefined };
		};

		fire(value) {
			for (const listener of this.listeners) {
				listener(value);
			}
		}

		dispose() {}
	}

	const watchers = [];

	return {
		"watchers": watchers,
		"vscode": {
			"Uri": { "file": uri, "joinPath": (base, ...parts) => uri([base.path, ...parts].join("/")) },
			"FileType": { "File": 1, "Directory": 2 },
			"EventEmitter": EventEmitter,
			"workspace": {
				"workspaceFolders": [{ "uri": uri("/workspace") }],
				"asRelativePath": (target) => target.path.slice("/workspace/".length),
				"fs": {
					"readFile": async (target) => {
						if (!files.has(target.path)) {
							throw new Error(`${target.path}: no such file`);
						}

						return new TextEncoder().encode(files.get(target.path));
					},
					"readDirectory": async (target) => {
						const entries = new Map();

						for (const path of files.keys()) {
							if (path.startsWith(`${target.path}/`)) {
								const [name, ...rest] = path.slice(target.path.length + 1).split("/");

								entries.set(name, rest.length === 0 ? 1 : 2);
							}
						}

						if (entries.size === 0) {
							throw new Error(`${target.path}: no such folder`);
						}

						return [...entries];
					}
				},
				"createFileSystemWatcher": (glob) => {
					const fired = { "create": new EventEmitter(), "change": new EventEmitter(), "delete": new EventEmitter() };
					const watcher = { "glob": glob, "fired": fired, "onDidCreate": fired.create.event, "onDidChange": fired.change.event, "onDidDelete": fired.delete.event, "dispose": () => undefined };

					watchers.push(watcher);

					return watcher;
				}
			},
			"commands": {
				"executeCommand": async (command, _source, file, refs) => {
					if (command !== "editor.annotations.resolve") {
						return undefined;
					}

					const answer = refs.map(({ span }) => where(span, file));

					return answer.includes("unparsable") ? { "unparsable": "rejected root state" } : { "value": answer };
				}
			}
		}
	};
}

const at = (start, end, file = "src/a.ts") => ({ "status": "attached", "candidate": { "file": file, "start": start, "end": end, "type": "Expression" } });

test("a file's evidence, every user's runs in every environment folded: counts summed, arms by arm, time with who called it, the latest report's time, and this machine's samples", async () => {
	const files = new Map([
		["/workspace/.silo/evidence/ann/node-24/src/a.ts.jsonl", line({ "kind": "reached", "span": "s1", "ever": 3, "runs": 1.5, "lastAt": "2026-11-01" }) + line({ "kind": "value", "span": "s2", "seen": 4, "nullish": 1, "tags": { "number": 3, "undefined": 1 }, "ever": 4, "runs": 1, "lastAt": "2026-11-01" }) + line({ "kind": "branch", "span": "s3", "arms": [2, 0], "ever": 2, "runs": 1, "lastAt": "2026-11-01" })],
		["/workspace/.silo/evidence/bo/browser/src/a.ts.jsonl", line({ "kind": "reached", "span": "s1", "ever": 1, "runs": 1, "lastAt": "2026-11-03" }) + line({ "kind": "value", "span": "s2", "seen": 2, "nullish": 0, "tags": { "number": 2 }, "ever": 2, "runs": 1, "lastAt": "2026-10-30" }) + line({ "kind": "branch", "span": "s3", "arms": [1, 1, 1], "ever": 3, "runs": 1, "lastAt": "2026-11-02" }) + line({ "kind": "time", "span": "s4", "w": 5, "totalMs": 9, "profiledMs": 100, "callers": { "main": 9 }, "callees": { "tax": 4 }, "runs": 1, "lastAt": "2026-11-02" })],
		["/workspace/.silo/evidence/bo/node-24/src/a.ts.jsonl", line({ "kind": "time", "span": "s4", "w": 1, "totalMs": 2, "profiledMs": 50, "callers": { "main": 1, "retry": 1 }, "callees": {}, "runs": 1, "lastAt": "2026-11-04" })],
		["/workspace/.silo/local/samples/src/a.ts.jsonl", line({ "span": "s2", "values": [7, 9] }) + line({ "span": "gone", "values": [1] })]
	]);
	const { vscode } = standIn(files, (span) => ({ "s1": at(0, 5), "s2": at(6, 9), "s3": at(10, 20), "s4": at(21, 30) })[span]);
	const store = evidenceStore(vscode, []);
	const placed = Object.fromEntries((await store.placedIn("src/a.ts", "the file as it is now")).map(({ start, evidence }) => [start, evidence]));

	assert.deepEqual(placed[0], { "reached": { "ever": 4, "runs": 2.5, "lastAt": "2026-11-03" } });
	assert.deepEqual(placed[6], { "value": { "seen": 6, "nullish": 1, "tags": { "number": 5, "undefined": 1 }, "ever": 6, "runs": 2, "lastAt": "2026-11-01" }, "samples": [7, 9] });
	assert.deepEqual(placed[10], { "branch": { "arms": [3, 1, 1], "ever": 5, "runs": 2, "lastAt": "2026-11-02" } }, "arms added by arm, the longer's kept");
	assert.deepEqual(placed[21], { "time": { "selfMs": 6, "totalMs": 11, "profiledMs": 150, "callers": { "main": 10, "retry": 1 }, "callees": { "tax": 4 }, "runs": 2, "lastAt": "2026-11-04" } });
	assert.deepEqual(await store.files(), ["src/a.ts"]);
});

test("a span found elsewhere, or not at all, isn't placed; a file BABLR can't parse places nothing, one with no evidence nothing either", async () => {
	const files = new Map([["/workspace/.silo/evidence/ann/node-24/src/a.ts.jsonl", ["s1", "s2", "s3"].map((span) => line({ "kind": "reached", "span": span, "ever": 1, "runs": 1, "lastAt": "2026-11-01" })).join("")]]);
	let parsable = true;
	const { vscode } = standIn(files, (span) => (parsable ? { "s1": at(0, 4), "s2": at(5, 9, "src/b.ts"), "s3": { "status": "lost" } }[span] : "unparsable"));
	const store = evidenceStore(vscode, []);

	assert.deepEqual((await store.placedIn("src/a.ts", "text")).map(({ start, end, type }) => [start, end, type]), [[0, 4, "Expression"]]);
	assert.deepEqual(await store.placedIn("src/none.ts", "text"), []);

	parsable = false;
	assert.deepEqual(await store.placedIn("src/a.ts", "text mid-edit"), []);

	// (a document: undefined while it can't be told, so what's drawn stays)
	const document = { "uri": vscode.Uri.file("/workspace/src/a.ts"), "version": 1, "getText": () => "text mid-edit" };

	assert.equal(await store.placed(document), undefined);
});

test("a document's placing is shared by the surfaces asking for its version, and one edited while placed isn't kept", async () => {
	const files = new Map([["/workspace/.silo/evidence/ann/node-24/src/a.ts.jsonl", line({ "kind": "reached", "span": "s1", "ever": 1, "runs": 1, "lastAt": "2026-11-01" })]]);
	let asked = 0;
	const { vscode } = standIn(files, () => {
		asked += 1;

		return at(0, 4);
	});
	const store = evidenceStore(vscode, []);
	const document = { "uri": vscode.Uri.file("/workspace/src/a.ts"), "version": 1, "getText": () => "text" };
	const [one, other] = await Promise.all([store.placed(document), store.placed(document)]);

	assert.equal(one, other);
	assert.equal(asked, 1);

	const editing = { ...document, "version": 2 };
	const placing = store.placed(editing);

	editing.version = 3;
	assert.equal(await placing, undefined, "edited since: a newer look follows");
});

test("this machine's counts, and someone else's committed lines as what was seen: coarse, never counted twice", async () => {
	const full = (kind, span, extra) => line({ "kind": kind, "span": span, "key": "bablr1", "w": 4, "ever": 4, "runs": 4, "lastRun": "r4", "lastAt": "2026-11-26", ...extra });
	const files = new Map([
		// (mine, every count — and my committed lines of the same runs, which say less of them)
		["/workspace/.silo/local/evidence/me/laptop/src/a.ts.jsonl", full("branch", "b", { "arms": [0, 4] }) + full("reached", "s", {})],
		["/workspace/.silo/evidence/me/laptop/src/a.ts.jsonl", line({ "span": "b", "key": "bablr1", "runs": 3, "kind": "branch", "taken": [1] }) + line({ "span": "s", "key": "bablr1", "runs": 3, "kind": "reached", "ran": true })],
		// (someone else's: committed lines only)
		["/workspace/.silo/evidence/bo/ci/src/a.ts.jsonl", line({ "span": "b", "key": "bablr1", "runs": 10, "kind": "branch", "taken": [0, 1] }) + line({ "span": "v", "key": "bablr1", "runs": 3, "kind": "value", "tags": ["string"], "nullish": false })]
	]);
	const { vscode } = standIn(files, () => at(0, 4));
	const placed = await evidenceStore(vscode, []).placedIn("src/a.ts", "text");
	const bySpan = (span) => placed.find((each) => each.evidence[span === "v" ? "value" : span === "s" ? "reached" : "branch"] !== undefined && (span !== "b" || each.evidence.branch !== undefined))?.evidence;

	assert.deepEqual(bySpan("s").reached, { "ever": 4, "runs": 4, "lastAt": "2026-11-26" }, "mine, counted: my committed line isn't added again");
	assert.deepEqual(bySpan("b").branch, { "arms": [1, 5], "ever": 14, "runs": 14, "lastAt": "2026-11-26", "coarse": true }, "mine and bo's: bo's taken arms, as taken");
	assert.deepEqual(bySpan("v").value, { "seen": 3, "nullish": 0, "tags": { "string": 3 }, "ever": 3, "runs": 3, "lastAt": "", "coarse": true });
});

test("a committed claim is claimed; another's line against it stays in the counts, for a fix to see", async () => {
	const files = new Map([
		["/workspace/.silo/evidence/bo/ci/src/a.ts.jsonl", line({ "span": "v", "key": "bablr1", "runs": 30, "claim": "neverNullish", "kind": "value", "tags": ["string"], "nullish": false }) + line({ "span": "s", "key": "bablr1", "runs": 30, "claim": "neverRan", "kind": "reached", "ran": false }) + line({ "span": "b", "key": "bablr1", "runs": 30, "kind": "branch", "taken": [1] })],
		["/workspace/.silo/evidence/cy/laptop/src/a.ts.jsonl", line({ "span": "s", "key": "bablr1", "runs": 3, "kind": "reached", "ran": true })]
	]);
	const { vscode } = standIn(files, () => at(0, 4));
	const placed = await evidenceStore(vscode, []).placedIn("src/a.ts", "text");
	const of = (kind) => placed.find((each) => each.evidence[kind] !== undefined)?.evidence[kind];

	assert.deepEqual(of("value"), { "seen": 30, "nullish": 0, "tags": { "string": 30 }, "ever": 30, "runs": 30, "lastAt": "", "coarse": true, "claimed": true });
	assert.deepEqual(of("reached"), { "ever": 3, "runs": 33, "lastAt": "", "coarse": true, "claimed": true }, "bo's claim, and cy's run of it: ran, in the counts");
	assert.equal(of("branch").claimed, undefined, "a line without a claim claims nothing");
});

test("every file with evidence, at any depth and once whoever ran it; a change to one is said, and it's read again", async () => {
	const files = new Map([
		["/workspace/.silo/evidence/ann/node-24/src/a.ts.jsonl", line({ "kind": "reached", "span": "s1", "ever": 1, "runs": 1, "lastAt": "2026-11-01" })],
		["/workspace/.silo/evidence/bo/browser/src/a.ts.jsonl", ""],
		["/workspace/.silo/evidence/bo/browser/src/deep/b.ts.jsonl", ""],
		["/workspace/.silo/evidence/bo/browser/notes.txt", ""]
	]);
	const { vscode, watchers } = standIn(files, () => at(0, 4));
	const subscriptions = [];
	const store = evidenceStore(vscode, subscriptions);
	const said = [];

	store.onDidChange((file) => said.push(file));
	assert.deepEqual(await store.files(), ["src/a.ts", "src/deep/b.ts"]);
	assert.deepEqual((await store.placedIn("src/a.ts", "text"))[0].evidence.reached.ever, 1);
	assert.deepEqual(watchers.map(({ glob }) => glob), ["**/.silo/evidence/**/*.jsonl", "**/.silo/local/evidence/**/*.jsonl", "**/.silo/local/samples/**/*.jsonl"]);
	assert.ok(subscriptions.length > watchers.length, "its emitter, watchers and their listeners, disposed with the extension");

	const path = "/workspace/.silo/evidence/ann/node-24/src/a.ts.jsonl";

	files.set(path, line({ "kind": "reached", "span": "s1", "ever": 5, "runs": 2, "lastAt": "2026-11-05" }));
	watchers[0].fired.change.fire(vscode.Uri.file(path));
	watchers[1].fired.create.fire(vscode.Uri.file("/workspace/.silo/local/samples/src/c.ts.jsonl"));
	watchers[0].fired.delete.fire(vscode.Uri.file("/workspace/.silo/somewhere-else.jsonl"));
	assert.deepEqual(said, ["src/a.ts", "src/c.ts"]);
	assert.equal((await store.placedIn("src/a.ts", "text"))[0].evidence.reached.ever, 5);
});
