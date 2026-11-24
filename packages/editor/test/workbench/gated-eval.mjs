/**
 * Untrusted code in a locked-down realm (editor-api's gated-eval.ts), as the workbench runs it — a library with no UI of
 * its own: only data comes back — its export, awaited when it's a promise, and what it logged; its network and helpers
 * are refused and recorded; `require` gets what it was given and an inert stub otherwise; `host` reaches only what a
 * caller grants; and code that runs too long is ended with its realm, the next call in a new one.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/gated-eval.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("gated-eval");
/** The module as the workbench's dev server serves it. */
const MODULE = "/@fs" + path.resolve(import.meta.dirname, "../../../editor-api/src/gated-eval.ts");

/** `code` run in the realm from the workbench; each of `granted` a service answering with what it was asked. */
async function evaluate(code, { imports = {}, timeoutMs = 5000, granted = [] } = {}) {
	return session.workbench().evaluate(async ([module, source, given, limit, names]) => {
		const { gatedEvalRealm } = await import(module);

		return gatedEvalRealm(source, given, limit, Object.fromEntries(names.map((name) => [name, async (...args) => ({ "service": name, "args": args })])));
	}, [MODULE, code, imports, timeoutMs, granted]);
}

test("only data comes back: what it exports, awaited, and what it logged", async () => {
	const exported = await evaluate("console.log(\"made\", { \"n\": 2 });\nmodule.exports = { \"total\": 1 + 2, \"names\": [\"a\", \"b\"] };");

	assert.deepEqual(exported.value, { "total": 3, "names": ["a", "b"] });
	assert.deepEqual(exported.logs, ["made {\"n\":2}"]);
	assert.equal((await evaluate("module.exports = async () => [1, 2, 3].map((each) => each * 2);")).value.join(), "2,4,6", "an exported function is called, its promise awaited");
	assert.equal((await evaluate("exports.default = \"the default\";")).value, "the default");
	assert.match((await evaluate("module.exports = () => { throw new Error(\"no\"); };")).error, /no/u);
	assert.match((await evaluate("this is not code")).error, /Unexpected/u);
});

test("its network and helpers are refused, and what it tried is recorded", async () => {
	const tried = await evaluate("const said = [];\nfor (const reach of [() => fetch(\"https://example.com/\"), () => new XMLHttpRequest(), () => new WebSocket(\"wss://example.com/\"), () => new Worker(\"x.js\"), () => importScripts(\"x.js\")]) {\n\ttry { reach(); } catch (error) { said.push(error.message); }\n}\nmodule.exports = said;");

	assert.equal(tried.value.length, 5);
	assert.ok(tried.value.every((message) => message.startsWith("sandbox: capability")), tried.value.join("\n"));
	assert.deepEqual([...new Set(tried.attempts)].toSorted(), ["eval:importScripts", "eval:worker", "net:*"]);
	assert.deepEqual((await evaluate("try { globalThis.fetch = () => 1; } catch {}\ntry { fetch(\"https://example.com/\"); } catch (error) { module.exports = error.message; }")).value, "sandbox: capability 'net:*' is not available", "and it can't put them back");
});

test("require gets what it was given, and a stub for anything else; host reaches only what's granted", async () => {
	const required = await evaluate("const config = require(\"./config.json\");\nconst missing = require(\"left-pad\");\nmodule.exports = { \"name\": config.name, \"stubbed\": typeof missing };", { "imports": { "./config.json": { "name": "given" } } });

	assert.equal(required.value.name, "given");
	assert.equal(required.value.stubbed, "function", "a stub, so evaluation survives");

	const asked = await evaluate("module.exports = async () => [await host(\"read\", \"a.json\", 2), await host(\"write\", \"b.json\").catch((error) => error.message)];", { "granted": ["read"] });

	assert.deepEqual(asked.value, [{ "service": "read", "args": ["a.json", 2] }, "sandbox: no service 'write'"]);
});

test("code that runs too long is ended with its realm, and the next call runs in a new one", async () => {
	const runaway = await evaluate("for (;;) {}", { "timeoutMs": 500 });

	assert.deepEqual(runaway, { "error": "timed out", "attempts": [] });
	assert.equal((await evaluate("module.exports = 1 + 1;")).value, 2);
});
