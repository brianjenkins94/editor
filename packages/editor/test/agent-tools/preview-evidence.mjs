/**
 * What a preview's page observed, kept in git (previews/page-evidence.ts): its counts, under its dev server's run, as
 * the server stops.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/preview-evidence.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("preview-evidence");
const { ask } = session;

test("what a preview observed is kept too: its page's counts on this machine and what was seen in git, under the dev server's run, as the server stops", async () => {
	await ask("files.write", { "path": "evpreview/index.html", "content": "<!doctype html><html><head><title>evpreview</title></head><body><button>not yet</button><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n" });
	await ask("files.write", { "path": "evpreview/src/main.ts", "content": "const hooks: { onClick?: () => void } = { \"onClick\": () => undefined };\nconst button = document.querySelector(\"button\")!;\nlet count = 0;\n\nbutton.textContent = \"ready\";\nbutton.addEventListener(\"click\", () => {\n\tcount += 1;\n\thooks.onClick?.();\n\tbutton.textContent = count > 1 ? \"many\" : \"once\";\n});\n" });
	await session.terminal("cd evpreview && vite", { "fresh": true });

	// (its page, instrumented: its script ran, the optional call in its handler with it)
	const button = async () => session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentDocument?.querySelector("button")).find((each) => each?.textContent === "ready" || each?.textContent === "once" || each?.textContent === "many")?.textContent);

	await session.eventually("the app's page", async () => (await button()) === "ready" || undefined, 90_000);

	for (let clicks = 0; clicks < 3; clicks += 1) {
		await session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentDocument?.querySelector("button")).find((each) => each !== null && each !== undefined && each.textContent !== "not yet")?.click());
	}

	assert.equal(await button(), "many");

	const server = (await ask("runs.list")).find(({ cwd, state }) => cwd.endsWith("/evpreview") && state === "running");

	assert.ok(server !== undefined, "the dev server's run");

	// (what the page counted, and the run, said if nothing's kept)
	const counted = await session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentWindow?.__evidence?.evidence?.()?.map(({ file, sites }) => ({ "file": file, "sites": sites.length }))));

	await ask("runs.stop", { "id": server.id });

	// (the page reports as its window closes, and the run's recorded as it ends)
	const observations = await session.eventually("the preview's evidence", async () => {
		const [file] = (await ask("files.glob", { "pattern": ".silo/evidence/**/evpreview/src/main.ts.jsonl" })).files;

		// (the counts: this machine's, beside it under .silo/local, which isn't searched)
		return file === undefined ? undefined : (await ask("files.read", { "path": file.replace(".silo/evidence/", ".silo/local/evidence/") })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
	}, 60_000).catch(async (error) => {
		const after = (await ask("runs.list")).find(({ id }) => id === server.id);
		const envelopes = [];

		for (const file of (await ask("files.glob", { "pattern": ".silo/runs/*.jsonl" })).files) {
			envelopes.push(...(await ask("files.read", { "path": file })).content.split("\n").filter((line) => line.includes("evpreview")));
		}

		throw new Error(`${error.message}: the page counted ${JSON.stringify(counted)}; its server's run, after: ${JSON.stringify(after)}; its envelopes: ${JSON.stringify(envelopes)}; evidence kept: ${JSON.stringify((await ask("files.glob", { "pattern": ".silo/evidence/**" })).files)}`, { "cause": error });
	});

	assert.ok(observations.some(({ kind, seen, nullish, tags }) => kind === "value" && seen === 3 && nullish === 0 && tags?.function === 3), JSON.stringify(observations));
	assert.ok(observations.some(({ kind, arms }) => kind === "branch" && arms?.join() === "2,1"), "the ?: took its first arm twice, its second once");
	assert.ok(observations.some(({ kind }) => kind === "reached"));

	const [committedFile] = (await ask("files.glob", { "pattern": ".silo/evidence/**/evpreview/src/main.ts.jsonl" })).files;
	const committed = (await ask("files.read", { "path": committedFile })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

	assert.ok(committed.some(({ kind, taken }) => kind === "branch" && taken?.join() === "0,1"), "committed: what was seen, each arm taken");
	await ask("files.delete", { "path": "evpreview" });
});
