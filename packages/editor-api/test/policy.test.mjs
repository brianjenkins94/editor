// The capability decisions kept for a project (policy.ts): my overrides over the shared contract, read again when either
// changes on disk; what I decide written to my file, never the contract; a placed rule's place kept up; and what calls
// returned when they ran for real, kept on this machine. Through a stand-in for the extension API's `vscode` module:
// the workspace's files in memory.
import * as assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as path from "node:path";
import { test } from "node:test";

import { EMPTY_POLICY, withRule } from "@brianjenkins94/util/silo/policy";

/** The workspace, by absolute path: its text, and a stamp that changes with each write. */
const files = new Map();
let clock = 0;
const put = (file, text) => {
	clock += 1;
	files.set(file, { "text": text, "mtime": clock });
};
const read = (file) => files.get(file)?.text;

const uri = (file) => ({ "path": file, "scheme": "file", "toString": () => `file://${file}` });

globalThis.__vscodeStandIn = {
	"Uri": { "file": uri, "joinPath": (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
	"workspace": {
		"workspaceFolders": [{ "uri": uri("/workspace") }],
		"asRelativePath": (target) => target.path.slice("/workspace/".length),
		"fs": {
			"readFile": async (target) => {
				if (!files.has(target.path)) {
					throw new Error(`${target.path}: no such file`);
				}

				return new TextEncoder().encode(read(target.path));
			},
			"writeFile": async (target, bytes) => {
				put(target.path, new TextDecoder().decode(bytes));
			},
			"createDirectory": async () => undefined,
			"stat": async (target) => {
				const file = files.get(target.path);

				if (file === undefined) {
					throw new Error(`${target.path}: no such file`);
				}

				return { "mtime": file.mtime, "size": file.text.length };
			}
		}
	}
};

registerHooks({
	"resolve": (specifier, context, next) => (specifier === "vscode" ? { "url": new URL("vscode-stand-in.mjs", import.meta.url).href, "shortCircuit": true } : next(specifier, context))
});

put("/workspace/.git/config", "[user]\n\tname = Ann Example\n\temail = ann@example.com\n");

const { loadEffectivePolicy, loadPolicyFiles, movePlace, persistOverride, recordedResult, recordedResults, recordObservation, recordResult, replaceRule } = await import("../src/policy.ts");
const { takeEffects } = await import("../src/effects.ts");

const contract = withRule({ ...EMPTY_POLICY }, "net", "https://example.com/", "deny", "2026-01-01");
const whose = (policy) => policy.rules.map((rule) => `${rule.then[0].action_id} ${rule.when.predicates.map(({ argument }) => argument).join(" ")}`);

test("the policy consulted: my overrides first, over the shared contract, mine named by the git user", async () => {
	put("/workspace/.silo/policy.json", JSON.stringify(contract));
	put("/workspace/.silo/policy/ann.json", JSON.stringify(withRule({ ...EMPTY_POLICY }, "net", "https://example.com/", "allow", "2026-02-01")));

	assert.deepEqual(whose(await loadEffectivePolicy()), ["allow net https://example.com/", "deny net https://example.com/"]);

	const apart = await loadPolicyFiles();

	assert.deepEqual([apart.mine.file, apart.mine.rules.length, apart.shared.file, apart.shared.rules.length], [".silo/policy/ann.json", 1, ".silo/policy.json", 1]);
});

test("a policy file changed by someone else is read again: its text, not a watcher", async () => {
	put("/workspace/.silo/policy.json", JSON.stringify(withRule(contract, "fs:write", "/workspace/out.txt", "allow", "2026-01-02")));

	assert.deepEqual(whose(await loadEffectivePolicy()), ["allow net https://example.com/", "allow fs:write /workspace/out.txt", "deny net https://example.com/"]);
});

test("a policy file rewritten to the same size in the same millisecond is read again: its text, not its stamp", async () => {
	const file = "/workspace/.silo/policy.json";
	const before = read(file);
	const { mtime } = files.get(file);

	await loadEffectivePolicy();

	// (a rule's place moved: the same size, and here the same mtime too)
	const same = before.replace("example.com", "example.org");

	assert.equal(same.length, before.length);
	files.set(file, { "text": same, "mtime": mtime });
	assert.ok(whose(await loadEffectivePolicy()).includes("deny net https://example.org/"));
	files.set(file, { "text": before, "mtime": mtime });
	assert.ok(whose(await loadEffectivePolicy()).includes("deny net https://example.com/"), "and back");
});

test("what I decide is written to my file, never the contract: a call's decision kept with when it was first made", async () => {
	const before = read("/workspace/.silo/policy.json");

	await persistOverride("exec", "git status", "allow");

	const first = JSON.parse(read("/workspace/.silo/policy/ann.json")).rules[0].added;

	await new Promise((resolve) => {
		setTimeout(resolve, 5);
	});
	await persistOverride("exec", "git status", "deny");

	const mine = JSON.parse(read("/workspace/.silo/policy/ann.json"));

	assert.deepEqual(whose(mine), ["deny exec git status", "allow net https://example.com/"]);
	assert.ok(first > "2026-11", first);
	assert.equal(mine.rules[0].added, first, "flipped, it keeps when it was first decided");
	assert.equal(read("/workspace/.silo/policy.json"), before);
	assert.deepEqual(whose(await loadEffectivePolicy()).slice(0, 2), ["deny exec git status", "allow net https://example.com/"], "kept as written: no read needed");
});

test("a rule made in the rule editor: an edit of mine in its place, a new one first, an edit of the contract's shadowing it, none to take one out", async () => {
	const [gitStatus, net] = (await loadPolicyFiles()).mine.rules;
	const edited = { ...gitStatus, "then": [{ "action_id": "ask" }] };

	await replaceRule(gitStatus, edited);
	assert.deepEqual(whose(JSON.parse(read("/workspace/.silo/policy/ann.json"))), ["ask exec git status", "allow net https://example.com/"]);

	const [shared] = (await loadPolicyFiles()).shared.rules;

	await replaceRule(shared, { ...shared, "then": [{ "action_id": "deny" }] });
	assert.deepEqual(whose(JSON.parse(read("/workspace/.silo/policy/ann.json"))), ["deny fs:write /workspace/out.txt", "ask exec git status", "allow net https://example.com/"]);

	await replaceRule(net, undefined);
	assert.deepEqual(whose(JSON.parse(read("/workspace/.silo/policy/ann.json"))), ["deny fs:write /workspace/out.txt", "ask exec git status"]);
	assert.ok(JSON.parse(read("/workspace/.silo/policy/ann.json")).rules[0].added > "2026-11", "a changed rule is decided now");
});

test("a placed rule's place kept up with its code: replaced where it is, mine or the contract's, its decision unchanged", async () => {
	const [shared] = (await loadPolicyFiles()).shared.rules;
	const moved = { ...shared, "when": { ...shared.when, "predicates": [...shared.when.predicates, { "target_id": "at", "operator_id": "is", "argument": { "file": "b.js" } }] } };

	await movePlace("shared", shared, moved);
	assert.deepEqual(JSON.parse(read("/workspace/.silo/policy.json")).rules[0], moved);

	const contractNow = read("/workspace/.silo/policy.json");

	await movePlace("shared", shared, moved);
	assert.equal(read("/workspace/.silo/policy.json"), contractNow, "changed since it was read: left alone");
});

test("what calls returned for real: the latest of each, on this machine only, the oldest going past 200", async () => {
	await recordResult("net", "https://example.com/a", { "first": true });
	await recordResult("net", "https://example.com/a", { "second": true });
	await recordResult("fs:read", "/workspace/a.txt", "text", "range 0-4");

	assert.deepEqual((await recordedResult("net", "https://example.com/a")).value, { "second": true });
	assert.equal((await recordedResult("fs:read", "/workspace/a.txt", "range 0-4")).value, "text");
	assert.equal(await recordedResult("fs:read", "/workspace/a.txt"), undefined, "another request is another call");
	assert.match(read("/workspace/.silo/.gitignore"), /^\/local\/$/mu, "kept out of git");

	await Promise.all(Array.from({ "length": 200 }, (_, index) => recordResult("net", `https://example.com/${String(index)}`, index)));

	const kept = await recordedResults();

	assert.equal(Object.keys(kept).length, 200);
	assert.equal(kept["net https://example.com/a"], undefined, "the oldest went");
	assert.equal(kept["net https://example.com/199"], 199);
});

test("a gated decision on a run is counted among its effects: made or denied, and how it was decided", () => {
	recordObservation({ "kind": "fs", "op": "write", "resource": "/workspace/out.txt" }, "allow", "run-1");
	recordObservation({ "kind": "net", "resource": "https://example.com/" }, "deny", "run-1", "once");
	recordObservation({ "kind": "net", "resource": "https://example.com/" }, "deny");

	assert.deepEqual(takeEffects("run-1").map(({ capability, resource, how, decided }) => [capability, resource, how, decided]), [["fs:write", "/workspace/out.txt", "made", undefined], ["net", "https://example.com/", "denied", "once"]]);
});
