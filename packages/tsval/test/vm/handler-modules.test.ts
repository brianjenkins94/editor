/**
 * The handler modules have no load-order dependence: each registers through an exported
 * `register()` the aggregator calls after every module has loaded, so no module reads another at
 * evaluation time. Proven the only way it can be: each module imported ALONE in a fresh process,
 * and all of them imported in reverse order.
 */
import assert from "node:assert/strict";
// eslint-disable-next-line ts/no-restricted-imports -- sync fs.readdirSync (listing handler modules on disk) has no equivalent in the async-only util/fs wrapper
import fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as url from "node:url";
import { exec } from "@brianjenkins94/util/exec";

const dir = path.resolve(import.meta.dirname, "../../src/handlers");
const modules = fs.readdirSync(dir).filter((entry) => entry.endsWith(".ts")).sort();

// util/exec returns a result (doesn't throw on non-zero), so assert `ok` explicitly. stdout is trimmed → "ok".
async function importIn(specifiers: string[]): Promise<string> {
	const code = specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join("\n") + "\nconsole.log('ok');";
	const result = await exec(process.execPath, ["--input-type=module", "-e", code], { "stdio": "pipe" });

	assert.ok(result.ok, `import failed (exit ${result.exitCode}): ${result.stderr}`);

	return result.stdout;
}

for (const file of modules) {
	test(`handler module loads alone: ${file}`, async () => {
		assert.equal(await importIn([url.pathToFileURL(path.join(dir, file)).href]), "ok");
	});
}

test("handler modules load in reverse order, then the aggregator registers them all", async () => {
	const reversed = [...modules].reverse().map((entry) => url.pathToFileURL(path.join(dir, entry)).href);

	assert.equal(await importIn([...reversed, url.pathToFileURL(path.resolve(dir, "../handlers.ts")).href]), "ok");
});
