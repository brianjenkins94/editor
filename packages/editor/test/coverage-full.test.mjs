// The editor's own build counted in full (build/coverage.ts, COVERAGE=full; previews/editor-evidence.ts): each module
// instrumented with what its values and branches were as well as which statements ran, versioned by its source's blob,
// and a realm's runtime answering the coverage channel — the realms, what ran, the counts, and all of it when asked.
//
//   node --import tsx --test test/coverage-full.test.mjs
import assert from "node:assert/strict";
import * as path from "node:path";
import { after, test } from "node:test";
import * as url from "node:url";
import { runInNewContext } from "node:vm";

const { blobOid, bundledRuntime, instrumented, levelOf, RUNTIME_ID } = await import("../build/coverage.ts");

const REPO = path.resolve(url.fileURLToPath(new URL("../../../", import.meta.url)));
const FILE = path.join(REPO, "packages/editor/workbench/sample.ts");
const SOURCE = "export function greet(name) {\n\tif (name === null) {\n\t\treturn \"nobody\";\n\t}\n\n\treturn \"hello \" + name;\n}\n\nglobalThis.said = [greet(\"ann\"), greet(\"bo\"), greet(null)];\n";

/** What the realms on the coverage channel answer `ask`, collected for a moment. */
async function asked(ask) {
	const channel = new BroadcastChannel("editor.coverage");
	const nonce = String(Math.random());
	const answers = [];

	channel.addEventListener("message", ({ data }) => {
		if (data.answer === nonce) {
			answers.push(data);
		}
	});
	channel.postMessage({ ...ask, "nonce": nonce });
	await new Promise((resolve) => {
		setTimeout(resolve, 200);
	});
	channel.close();

	return answers;
}

test("COVERAGE=1 counts statements, COVERAGE=full everything, unset nothing", () => {
	assert.deepEqual([levelOf("1"), levelOf("full"), levelOf(undefined), levelOf("0")], ["coverage", "full", undefined, undefined]);
	assert.equal(instrumented(SOURCE, "/elsewhere/sample.ts", "full"), undefined, "code that isn't the editor's own isn't instrumented");
});

test("a module counted in full: its runtime imported once, its version its source's blob, and a realm answers with its values, branches and statements", async () => {
	const code = instrumented(SOURCE, FILE, "full");

	assert.ok(code.startsWith(`import ${JSON.stringify(RUNTIME_ID)};\n`), "the runtime, imported before the module runs");
	assert.equal(blobOid("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a", "a source's version is git's blob id for it");

	// (the realm's channel and timers, closed after: the runtime keeps them for as long as its realm lives)
	const opened = [];
	const timers = [];
	const context = {
		"BroadcastChannel": class extends BroadcastChannel {
			constructor(name) {
				super(name);
				opened.push(this);
			}
		},
		"console": console,
		"setTimeout": setTimeout,
		"clearTimeout": clearTimeout,
		"setInterval": (...args) => {
			const timer = setInterval(...args);

			timers.push(timer);

			return timer;
		},
		"clearInterval": clearInterval,
		"performance": performance,
		"addEventListener": () => undefined,
		"queueMicrotask": queueMicrotask
	};

	after(() => {
		for (const channel of opened) {
			channel.close();
		}

		for (const timer of timers) {
			clearInterval(timer);
		}
	});

	context.globalThis = context;
	runInNewContext(await bundledRuntime(), context);
	runInNewContext(code.slice(code.indexOf("\n") + 1).replace(/^export /mu, ""), context);
	assert.deepEqual([...context.said], ["hello ann", "hello bo", "nobody"]);

	const realms = await asked({ "ask": "realms" });

	assert.equal(realms.length, 1);

	const [{ modules }] = await asked({ "ask": "full", "realms": [realms[0].realm] });
	const [module] = modules;

	assert.equal(module.file, "packages/editor/workbench/sample.ts");
	assert.equal(module.version, blobOid(SOURCE));
	assert.ok(module.statements.some((statement) => statement.start[0] === 2 && statement.count === 1), "return \"nobody\" (line 2, from 0) ran once");

	const branch = module.sites.find((site) => site.site === "branch");
	const parameter = module.sites.find((site) => site.site === "parameter");

	assert.deepEqual(branch.arms, [1, 2], "the if: then once, else twice");
	assert.deepEqual([parameter.seen, parameter.nullish], [3, 1], "name: three values, one nullish");

	const [{ ran }] = await asked({ "ask": "ran", "realms": [realms[0].realm] });

	assert.ok(ran["packages/editor/workbench/sample.ts"].length > 0, "and what ran, as the statement-only runtime said it");
	context.__evidence.publish();
});
