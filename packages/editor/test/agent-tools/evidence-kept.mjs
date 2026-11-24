/**
 * What a run and a preview observed, kept in git: .silo/runs and .silo/evidence.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/evidence-kept.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("evidence-kept");
const { ask } = session;

test("what a run observed is kept in git: its envelope in .silo/runs, each statement's count and each site's values and branches in .silo/evidence", async () => {
	await ask("files.write", { "path": "observed.mjs", "content": "function play(world, score) {\n\tworld.onWin?.();\n\n\treturn score > 10 ? \"won\" : \"lost\";\n}\n\nconst world = { \"onWin\": () => undefined };\n\nconsole.log(play(world, 12), play(world, 3));\n" });

	const ran = await session.request("debug.start", { "program": "observed.mjs" }, 120_000);

	assert.equal(ran.state, "terminated", JSON.stringify(ran));

	// (written as the run ends: its evidence first, the envelope last)
	const runs = await session.eventually("the run's envelope", async () => {
		const found = (await ask("files.glob", { "pattern": ".silo/runs/*.jsonl" })).files;

		for (const file of found) {
			const lines = (await ask("files.read", { "path": file })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.includes("observed.mjs"));

			if (lines.length > 0) {
				return lines.map((line) => JSON.parse(line));
			}
		}

		return undefined;
	}, 60_000);
	const [envelope] = runs;

	assert.deepEqual([envelope.type, envelope.entry, envelope.exit, envelope.environment.runtime], ["run", "observed.mjs", 0, "tsval"]);
	assert.match(envelope.files["observed.mjs"], /^[\da-f]{40}$/u);

	const [evidenceFile] = (await ask("files.glob", { "pattern": `.silo/evidence/${envelope.user}/**/observed.mjs.jsonl` })).files;
	const observations = (await ask("files.read", { "path": evidenceFile })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

	assert.ok(observations.some(({ kind, arms }) => kind === "branch" && arms?.join() === "1,1"), "the ?: took each arm once");
	assert.ok(observations.some(({ kind, seen, nullish, tags }) => kind === "value" && seen === 2 && nullish === 0 && tags?.function === 2), "world.onWin was a function both times it was reached");
	assert.ok(observations.some(({ kind }) => kind === "reached"), "and the statements that ran");
	await ask("files.delete", { "path": "observed.mjs" });
});

test("what a preview observed is kept in git too: its page's counts, under the dev server's run, as the server stops", async () => {
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

		return file === undefined ? undefined : (await ask("files.read", { "path": file })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
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
	await ask("files.delete", { "path": "evpreview" });
});
