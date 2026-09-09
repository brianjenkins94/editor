/**
 * The handler modules have no load-order dependence: each registers through an exported
 * `register()` the aggregator calls after every module has loaded, so no module reads another at
 * evaluation time. Proven the only way it can be: each module imported ALONE in a fresh process,
 * and all of them imported in reverse order.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const dir = path.resolve(import.meta.dirname, "../../src/handlers");
const modules = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();

function importIn(specifiers: string[]): string {
	return execFileSync(process.execPath, ["--input-type=module", "-e", specifiers.map((s) => `await import(${JSON.stringify(s)});`).join("\n") + "\nconsole.log('ok');"], { "encoding": "utf8", "stdio": ["ignore", "pipe", "pipe"] }).trim();
}

for (const file of modules) {
	test(`handler module loads alone: ${file}`, () => {
		assert.equal(importIn([pathToFileURL(path.join(dir, file)).href]), "ok");
	});
}

test("handler modules load in reverse order, then the aggregator registers them all", () => {
	const reversed = [...modules].reverse().map((f) => pathToFileURL(path.join(dir, f)).href);

	assert.equal(importIn([...reversed, pathToFileURL(path.resolve(dir, "../handlers.ts")).href]), "ok");
});
