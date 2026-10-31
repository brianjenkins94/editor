/**
 * Architecture tour, the previews: two dev servers side by side and what runs in them (evidence across a hot update,
 * recorded stops, a node service's preview, a preview's prompt), a cold provoke round, a webview, the git review diff,
 * the dock, the event sheet, and this checkout's debug-mcp — each checked against what the live architecture view saw.
 *
 * One of the tour's shards, each in a session of its own so they run side by side (architecture-tour-session.mjs);
 * the diagram of what they saw together is architecture-diagram.mjs's.
 *
 *   node --test test/architecture-tour-previews.mjs      (see architecture-harness.mjs for the browser + dev server)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { alive, hasLabel } from "./architecture-harness.mjs";
import { eventually, pressInRuleView, ruleStatus, session, tour } from "./architecture-tour-session.mjs";

tour("architecture-tour-previews", { "debugMcp": true, "debugMcpPort": 7398 });

test("debug-mcp: this checkout's debug-mcp joins the hub tree", async () => {
	await session.until("root ⇄ debug-mcp", hasLabel("root", "debug-mcp", /^hello$/u));
});

test("previews: two dev servers side by side", async () => {
	await session.terminal("npm run dev");
	await session.until("preview :5173", hasLabel("preview:5173", "sw", /^GET /u));
	await session.terminal("cd apps/second && npm run dev", { "fresh": true });
	await session.until("preview :5174", hasLabel("preview:5174", "sw", /^GET /u));
	await session.until("its dev server", alive("vite:5174"));

	// Its modules instrumented for runtime evidence (RUNTIME-EVIDENCE.md, the third slice): the page runtime the tap
	// carries has counted what the app's own code did, by file and version, in the original source's positions.
	const counted = await eventually("the preview's runtime evidence", async () => {
		const frame = session.page.frames().find((each) => /\/__virtual__\/[^/]+\/5173\//u.test(each.url()));
		const modules = frame === undefined ? [] : await frame.evaluate(() => globalThis.__evidence?.evidence() ?? []).catch(() => []);
		const ran = modules.filter((module) => module.statements.some((statement) => statement.count > 0));

		return ran.length > 0 ? modules : undefined;
	});

	assert.ok(counted.every((module) => module.file.startsWith("/workspace/") && !module.file.includes("/node_modules/")), "workspace modules only");
	assert.ok(counted.every((module) => /^[0-9a-f]{40}$/u.test(module.version)), "each by its version: the source's blob oid");
});

// A preview run's runtime evidence (RUNTIME-EVIDENCE.md, the third slice): its pages count what its modules did, an HMR
// edit brings a second version of one, and when it stops, both versions are folded into the file's evidence — the
// statements the edit didn't touch counted across both — and the run's envelope lists both.
// Playwright tests in the debugger (packages/playwright; playwright-test.js): a test file's `page` drives the preview
// you have open — its locators found on the preview's page in the shell (`playwright.run`), its click a real one there,
// its expect waiting — and each test's result is data, as node:test's are.
test("playwright: a test file in the debugger drives the preview you have open", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);

	try {
		await request("files.write", { "path": "checks/app.spec.mjs", "content": [
			"import { expect, test } from \"@playwright/test\";",
			"",
			"test.describe(\"the app\", () => {",
			"\ttest(\"its button counts\", async ({ page }) => {",
			"\t\tawait expect(page.getByRole(\"heading\", { \"level\": 1 })).toContainText(\"App\");",
			"\t\tconst button = page.getByRole(\"button\");",
			"\t\tconst before = await button.textContent();",
			"",
			"\t\tawait button.click();",
			"\t\tawait expect(button).not.toHaveText(before);",
			"\t});",
			"",
			"\ttest(\"isn't there\", async ({ page }) => {",
			"\t\tawait expect(page.getByText(\"Nothing like this\")).toBeVisible({ \"timeout\": 500 });",
			"\t});",
			"});",
			""
		].join("\n") });

		const ran = await request("tests.run", { "files": ["checks/app.spec.mjs"] });
		const [file] = ran.files;

		assert.deepEqual(file.tests.map(({ id, outcome }) => [id, outcome]), [["checks/app.spec.mjs › the app › its button counts", "pass"], ["checks/app.spec.mjs › the app › isn't there", "fail"]], JSON.stringify(ran));
		assert.match(file.tests[1].error, /toBeVisible\(\) failed/u, "what didn't hold");
		assert.equal(file.exitCode, 1);
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/checks"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

test("evidence: a preview run, across a hot update", async () => {
	const write = (files) => session.workbench().evaluate(async (all) => {
		const { api } = globalThis.__editor;

		// (The workspace's file system makes no parents.)
		await api.workspace.fs.createDirectory(api.Uri.file("/workspace/evapp/src"));

		for (const [path, text] of Object.entries(all)) {
			await api.workspace.fs.writeFile(api.Uri.file(`/workspace/evapp/${path}`), new TextEncoder().encode(text));
		}
	}, files);
	const main = (word) => `const box = document.getElementById("out");\nfunction label(n?: number) { return n ?? "${word}"; }\nif (box) { box.textContent = String(label(1)) + String(label()); }\n`;

	await write({
		"package.json": JSON.stringify({ "name": "evapp", "private": true, "type": "module", "scripts": { "dev": "vite" } }),
		"index.html": "<!doctype html><html><head><meta charset=\"UTF-8\"></head><body><div id=\"out\"></div><script type=\"module\" src=\"./src/main.tsx\"></script></body></html>",
		"src/main.tsx": main("none")
	});
	await session.terminal("cd /workspace/evapp && npm run dev", { "fresh": true });

	const run = await eventually("its run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.cwd === "/workspace/evapp" && each.state === "running"));
	const versions = () => eventually("the page's counts", async () => {
		const frame = session.page.frames().find((each) => each.url().includes(`/${run.port}/`) && each.url().includes("/__virtual__/"));
		const modules = frame === undefined ? [] : await frame.evaluate(() => globalThis.__evidence?.evidence() ?? []).catch(() => []);

		return modules.filter((module) => module.file === "/workspace/evapp/src/main.tsx");
	});

	await eventually("the first version counted", async () => (await versions()).length === 1 || undefined);
	// An HMR edit: the module re-imported as a second version (a .tsx module accepts its own updates).
	await write({ "src/main.tsx": main("nada") });
	await eventually("the second version counted", async () => (await versions()).length === 2 || undefined);
	await session.request("runs.stop", { "id": run.id }, 5000);

	const found = await eventually("its evidence", () => session.workbench().evaluate(async (id) => {
		const { api } = globalThis.__editor;
		const text = (uri) => api.workspace.fs.readFile(uri).then((bytes) => new TextDecoder().decode(bytes), () => "");
		const find = async (folder, name) => {
			for (const [entry, type] of await api.workspace.fs.readDirectory(folder).then((all) => all, () => [])) {
				const child = api.Uri.joinPath(folder, entry);
				let hit;

				if (type === api.FileType.Directory) {
					hit = await find(child, name);
				} else if (entry === name) {
					hit = await text(child);
				}

				if (hit !== undefined) {
					return hit;
				}
			}

			return undefined;
		};

		const evidence = await find(api.Uri.file("/workspace/.silo/evidence"), "main.tsx.jsonl");
		const runsFolder = api.Uri.file("/workspace/.silo/runs");
		let envelope;

		for (const [name] of await api.workspace.fs.readDirectory(runsFolder).then((all) => all, () => [])) {
			const line = (await text(api.Uri.joinPath(runsFolder, name))).split("\n").find((each) => each.includes(id));

			envelope = line === undefined ? envelope : JSON.parse(line);
		}

		return evidence === undefined || envelope === undefined ? undefined : { "lines": evidence.trim().split("\n").map((line) => JSON.parse(line)), "envelope": envelope };
	}, run.id));

	assert.equal(found.envelope.environment.runtime, "preview");
	assert.equal(found.envelope.versions?.["evapp/src/main.tsx"]?.length, 2, "both versions it ran");
	assert.ok(found.lines.some((line) => line.kind === "reached" && line.ever === 1 && line.w >= 2), "a statement the edit didn't touch, run by both versions: one run, counted twice");
	assert.ok(found.lines.some((line) => line.kind === "value" && line.nullish >= 1), "n ?? …: undefined once");
	assert.ok(found.lines.some((line) => line.kind === "branch"), "the if's arms");
});

// A breakpoint in a page's code is a recorded stop (RUNNING.md, *A breakpoint in a page is a recorded stop*): the page
// can't stop, so each time the line runs what's in scope is recorded — previewed then — and shown in the margin, a
// column per time it ran, with the event the page was handling. Set on a running app, its file is re-instrumented and
// hot-updated; no framework needed.
test("recorded stops: a breakpoint in a page's handler records its scope each time it runs", async () => {
	const workbench = session.workbench();
	const file = "/workspace/stopsapp/src/main.ts";
	const write = (files) => workbench.evaluate(async (all) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.createDirectory(api.Uri.file("/workspace/stopsapp/src"));

		for (const [path, text] of Object.entries(all)) {
			await api.workspace.fs.writeFile(api.Uri.file(`/workspace/stopsapp/${path}`), new TextEncoder().encode(text));
		}
	}, files);

	await write({
		"package.json": JSON.stringify({ "name": "stopsapp", "private": true, "type": "module", "scripts": { "dev": "vite" } }),
		"index.html": "<!doctype html><html><head><meta charset=\"UTF-8\"></head><body><script type=\"module\" src=\"./src/main.ts\"></script></body></html>",
		"src/main.ts": [
			"const button = document.createElement(\"button\");",
			"let count = 0;",
			"",
			"button.id = \"add\";",
			"button.addEventListener(\"click\", (event) => {",
			"\tconst step = 2;",
			"\tconst next = count + step;",
			"",
			"\tcount = next;",
			"\tbutton.textContent = String(count);",
			"});",
			"document.body.append(button);",
			""
		].join("\n")
	});
	// The file open: its Margin is drawn, and says what it shows (`margin.state`, the Margin's).
	await workbench.evaluate((path) => globalThis.__editor.api.window.showTextDocument(globalThis.__editor.api.Uri.file(path)), file);
	await session.terminal("cd /workspace/stopsapp && npm run dev", { "fresh": true });

	const run = await eventually("its run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.cwd === "/workspace/stopsapp" && each.state === "running"));

	try {
		const page = () => session.page.frames().find((each) => each.url().includes(`/${run.port}/`) && each.url().includes("/__virtual__/"));

		await eventually("the app's button", async () => (await page()?.evaluate(() => document.getElementById("add") !== null).catch(() => false)) || undefined);
		// The breakpoint, on the running app: its file re-instrumented, hot-updated (a full reload, for an entry).
		await session.request("debug.breakpoints", { "program": file, "lines": [7] }, 10_000);
		await session.page.waitForTimeout(1500);
		await eventually("the button again", async () => (await page()?.evaluate(() => document.getElementById("add") !== null).catch(() => false)) || undefined);
		await page().evaluate(() => {
			document.getElementById("add").click();
			document.getElementById("add").click();
		});

		// Told as the preview's run's values (its production session's), each report every hit so far: the stop's line, a
		// cell per time it ran — `during = click, step = 2, …`.
		const { values } = await eventually("its stops, in the margin", async () => {
			const margin = await session.request("margin.state", { "file": file }, 10_000).catch(() => undefined);

			return margin?.values.some((row) => row.cells.filter((cell) => cell.includes("count = ")).length === 2) === true ? margin : undefined;
		});
		const at = (name, turn) => values.map((row) => new RegExp(`(?:^|, )${name} = (.*?)(?=, \\w+ = |$)`, "u").exec(row.cells[turn] ?? "")?.[1]).find((value) => value !== undefined);

		assert.deepEqual([at("count", 0), at("count", 1)], ["0", "2"], "count as it was each time");
		assert.deepEqual([at("step", 0), at("step", 1)], ["2", "2"]);
		assert.equal(at("during", 0), "click", "the event the page was handling");
		assert.match(at("event", 0), /^(?:Pointer|Mouse)Event click$/u, "a DOM event, by what it is");
		assert.equal(at("button", 1), "<button#add>", "a DOM node, by what it is");
		assert.ok(values.every((row) => row.line === 7), "on the breakpoint's line");
		assert.equal(at("next", 0), undefined, "not yet set: its own statement");

		// Stepping a recorded handler (RUNNING.md, *Stepping a recorded handler*): the second click's call, replayed in the
		// debugger — stopped at the stop on what it read then, and stepped on.
		await eventually("a replay started", async () => (await workbench.evaluate((path) => globalThis.__editor.api.commands.executeCommand("tsval.stepRecordedStop", { "file": path, "n": 2 }), file)) || undefined);

		const replay = await eventually("stopped at the stop", async () => (await session.request("debug.sessions", undefined, 5000)).find((each) => each.name.endsWith("(recorded)") && each.state === "stopped"));
		const local = (outcome, name) => outcome.locals.find((each) => each.name === name)?.value;

		try {
			assert.equal(replay.line, 7, "on the breakpoint's line");
			assert.equal(replay.name, "addEventListener(\"click\") · click #2 (recorded)", "the handler, by the call it was given to");

			const stopped = await session.request(`debug.session.${replay.session}.state`, undefined, 5000);

			assert.deepEqual([local(stopped, "count"), local(stopped, "step")], ["2", "2"], "as the second click had them");

			const stepped = await session.request(`debug.session.${replay.session}.step`, { "action": "next" }, 30_000);

			assert.equal(local(stepped, "next"), "4", "stepped on");
		} finally {
			await session.request(`debug.session.${replay.session}.stop`, undefined, 30_000).catch(() => undefined);
		}
	} finally {
		await session.request("runs.stop", { "id": run.id }, 5000).catch(() => undefined);
		await session.request("debug.breakpoints", { "program": file, "lines": [] }, 10_000).catch(() => undefined);
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/stopsapp"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

test("provoke: a cold transform round in a child worker", async () => {
	await session.request("preview.provoke", { "rounds": 1, "hardReset": true }, 90_000);
	await session.until("node ⇄ provoke worker", hasLabel("node", "provoke", /./u));
	await session.until("the provoke worker's mount", hasLabel("provoke", "zenfs", /^mount /u));
});

// The preview's capability prompt (shell-preview.ts): Rule… makes the rule in the Rules view, prefilled with the call,
// and the call waits on it — saved, it decides the call.
test("preview prompt: Rule… makes the rule in the Rules view, and the call waits on it", async () => {
	const workbench = session.workbench();
	// A preview's own fetch: the service worker gates it, and asks in that preview's window. (A host the previews reach
	// anyway: esm.sh.) The preview found can be mid-navigation, a reload an earlier test's run left: then it's asked
	// again, in the frame found then.
	const ask = async (tries = 5) => {
		const preview = await eventually("a preview", () => session.page.frames().find((frame) => /\/__virtual__\/[^/]+\/\d+\//u.test(frame.url())));

		try {
			return await preview.evaluate(() => fetch("https://esm.sh/").then((response) => response.statusText, (error) => String(error)));
		} catch (error) {
			if (tries > 1 && /Execution context was destroyed|Frame was detached/u.test(String(error))) {
				return ask(tries - 1);
			}

			throw error;
		}
	};
	const decided = ask();
	const rule = session.page.locator("wa-button", { "hasText": "Rule…" });

	await rule.first().waitFor({ "timeout": 30_000 });
	await rule.first().click();
	await eventually("the rule, in the Rule view", () => ruleStatus().then((text) => (text === "Covers this call: allows it" ? text : undefined)));
	await pressInRuleView("Save as rule");
	// Allowed: the fetch goes out (wherever it gets) instead of the gate's 403.
	assert.notEqual(await decided, "Capability denied");

	const { mine } = await session.execute("silo.rules.files");

	assert.deepEqual(mine.rules[0].when.predicates.map(({ "target_id": targetId, argument }) => [targetId, argument]), [["capability", "net"], ["resource", "esm.sh"]]);
	await session.execute("silo.rules.set", mine.rules[0]);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// A preview's fetch given a result in its place (RUNNING.md, *A call's result*): a rule's, without the network — and,
// nobody watching the preview (every preview frame hidden), its recording where the policy would ask, or halted when it
// never ran for real (*Unattended runs*: decided 2026-10-24, the preview's reload on an edit is the app's run).
test("a preview's fetch: a rule's result given in its place; unwatched, its recording, or halted", async () => {
	const workbench = session.workbench();
	const given = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "net" }, { "target_id": "resource", "operator_id": "is", "argument": "https://api.example.com/rates" }] }, "then": [{ "action_id": "give", "target_id": "result", "argument": { "CA": 0.13 } }] };
	// (a preview's fetch, from its own page — found again if an earlier test's run left it mid-navigation)
	const fetched = async (url, tries = 5) => {
		const preview = await eventually("a preview", () => session.page.frames().find((frame) => /\/__virtual__\/[^/]+\/\d+\//u.test(frame.url())));

		try {
			return await preview.evaluate((address) => fetch(address).then(async (response) => ({ "status": response.status, "by": response.headers.get("x-silo-given"), "body": await response.text() }), (error) => ({ "error": String(error) })), url);
		} catch (error) {
			if (tries > 1 && /Execution context was destroyed|Frame was detached/u.test(String(error))) {
				return fetched(url, tries - 1);
			}

			throw error;
		}
	};
	// (every preview frame's box hidden, or shown again: as a dock tab behind another, nobody's watching it)
	const hidden = (hide) => session.page.evaluate((hiding) => {
		for (const frame of document.querySelectorAll("iframe")) {
			try {
				if (frame.contentWindow.location.pathname.startsWith("/__virtual__/")) {
					frame.parentElement.hidden = hiding;
				}
			} catch { /* another origin's: not a preview */ }
		}
	}, hide);

	await session.execute("silo.rules.set", undefined, given);
	await workbench.evaluate(async (recorded) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file("/workspace/.silo/local/recorded.json"), new TextEncoder().encode(JSON.stringify(recorded)));
	}, { "version": 1, "results": { "net https://api.example.com/recorded": { "value": { "FR": 0.2 }, "at": new Date().toISOString() } } });

	try {
		// The rule's result, and no request made.
		const ruled = await fetched("https://api.example.com/rates");

		assert.deepEqual([ruled.status, ruled.by, JSON.parse(ruled.body)], [200, "rule", { "CA": 0.13 }]);

		// Nobody watching: what it returned for real, given back — and one that never ran for real, halted.
		await hidden(true);

		const replayed = await fetched("https://api.example.com/recorded");

		assert.deepEqual([replayed.status, replayed.by, JSON.parse(replayed.body)], [200, "recording", { "FR": 0.2 }]);

		const halted = await fetched("https://api.example.com/never");

		assert.equal(halted.status, 503, JSON.stringify(halted));
		assert.match(halted.body, /^Halted: nobody's watching the preview, and https:\/\/api\.example\.com\/never never ran for real$/u);
	} finally {
		await hidden(false);
		await session.execute("silo.rules.set", given).catch(() => undefined);
		await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file("/workspace/.silo/local/recorded.json")).then(() => undefined, () => undefined));
	}
});

// An app's file runs the app (RUNNING.md, *Apps*): its code runs in its page, so Run starts its dev script — the dev
// server a run, its preview open — rather than stepping the file here; Run again shows the preview it already has.
test("run: an app's file runs the app — its dev server and its preview", async () => {
	const apps = async () => (await session.request("runs.list", undefined, 5000)).filter((run) => run.title === "npm run dev" && run.cwd === "/workspace" && run.state === "running");
	const app = async () => (await apps())[0];
	// (The tour's first test left the app's dev server running: then Run shows it, and this leaves it so.)
	const before = await app();
	const ran = await session.request("debug.start", { "program": "/workspace/src/main.tsx" }, 60_000);

	assert.equal(ran.reason, "app", "an app's, not stepped here");

	const running = await eventually("its dev server, a run", app);

	try {
		assert.equal(running.kind, "service");
		await eventually("its preview", () => session.page.frames().find((frame) => frame.url().includes(`/${running.port}/`) && frame.url().includes("/__virtual__/")));

		// Again: the one it has, not a second.
		assert.equal((await session.request("debug.start", { "program": "/workspace/src/App.tsx" }, 60_000)).reason, "app");
		await session.page.waitForTimeout(1000);
		assert.equal((await apps()).length, 1, "one dev server for the app");
	} finally {
		if (before === undefined) {
			await session.request("runs.stop", { "id": running.id }, 10_000).catch(() => undefined);
			await eventually("the dev server stopped", async () => ((await app()) === undefined || undefined));
		}
	}
});

// A service from the terminal runs as every run does (RUNNING.md, *Output goes where it was started*): in the debugger,
// its own timers keeping it going.
test("node script: a service runs in the debugger, and stopping it leaves the previews up", async () => {
	await session.terminal(`echo "setInterval(() => console.log('tick'), 300);" > forever.js && node forever.js`, { "fresh": true });
	await session.until("its debug run", hasLabel("bridge", "debug-worker", /^bridge\.ready$/u));
	await eventually("a running service", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node forever.js" && run.kind === "service" && run.state === "running") || undefined);
	await session.page.keyboard.press("Control+C");
	await eventually("the service stopped", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node forever.js" && run.state === "stopped") || undefined);

	const preview = session.page.frames().find((frame) => /__virtual__\/[^/]+\/5173\/$/u.test(frame.url()));

	assert.equal(await preview?.evaluate(async () => (await fetch(location.href)).status), 200);
});

// A preview asks for localhost:<port> as on a developer's machine, and the server on that port answers — here a node service
// on 3001 asked from the 5173 preview: each of its events arrives while the response is still open (the next is written
// only once the page has it), and an upload longer than one piece reaches it whole.
test("localhost: a preview's request for another port reaches its server, streamed both ways", async () => {
	const workbench = session.workbench();
	const server = [
		"const http = require('http');",
		"let events;",
		"let sent = 0;",
		"http.createServer((req, res) => {",
		"\tif (req.url === '/events') {",
		"\t\tres.writeHead(200, { 'content-type': 'text/event-stream' });",
		"\t\tevents = res;",
		"\t\tsent = 1;",
		"\t\tres.write('data: 1\\n\\n');",
		"\t\treturn;",
		"\t}",
		"\tif (req.url === '/next') {",
		"\t\tsent += 1;",
		"\t\tevents.write('data: ' + sent + '\\n\\n');",
		"\t\tif (sent === 3) events.end();",
		"\t\tres.end('wrote ' + sent);",
		"\t\treturn;",
		"\t}",
		"\tlet size = 0;",
		"\treq.on('data', (chunk) => { size += chunk.length; });",
		"\treq.on('end', () => res.end(req.method + ' ' + size));",
		"}).listen(3001);",
		""
	].join("\n");

	await workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file("/workspace/events-server.js"), new TextEncoder().encode(text));
	}, server);
	await session.terminal("node events-server.js", { "fresh": true });
	// Listening first: before then, a request for 3001 isn't any server's and goes to the network — asking the person.
	await eventually("its run, listening on 3001", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node events-server.js" && run.port === 3001) || undefined);

	// (The current frame each time: the preview's may be replaced as the run's windows come and go.)
	const preview = () => session.page.frames().find((frame) => /__virtual__\/[^/]+\/5173\/$/u.test(frame.url()));

	await eventually("the server on 3001, from the preview", async () => (await preview()?.evaluate(async () => (await fetch("http://localhost:3001/ping").then((response) => response.text(), () => "")).startsWith("GET")).catch(() => false)) || undefined);

	// Each event is written only once the page has the one before (it asks for the next): a body held back until its end
	// would leave the page waiting on the first. (Not timed: every piece crosses the tab's main thread, so a long task
	// there — the workbench's, on a loaded runner — holds the pieces written meanwhile, and they arrive together.)
	const events = await preview().evaluate(async () => {
		const reader = (await fetch("http://localhost:3001/events")).body.getReader();
		const late = () => new Promise((resolve) => {
			setTimeout(() => {
				resolve("late");
			}, 20_000);
		});
		const read = () => Promise.race([reader.read(), late()]);
		let text = "";
		let pieces = 0;

		for (let event = 1; event <= 3; event += 1) {
			while (!text.endsWith(`data: ${event}\n\n`)) {
				const piece = await read();

				if (piece === "late" || piece.done) {
					return { "text": text, "pieces": pieces, "missing": event };
				}

				text += new TextDecoder().decode(piece.value);
				pieces += 1;
			}

			if (event < 3) {
				await fetch("http://localhost:3001/next");
			}
		}

		const end = await read();

		return { "text": text, "pieces": pieces, "ended": end !== "late" && end.done };
	});

	assert.equal(events.missing, undefined, `each event as it's written, not the whole at the end: event ${events.missing} didn't arrive while the response was open (${JSON.stringify(events.text)})`);
	assert.equal(events.text, "data: 1\n\ndata: 2\n\ndata: 3\n\n");
	assert.ok(events.pieces >= 3, `in pieces as written: ${events.pieces}`);
	assert.ok(events.ended, "and it ends when the server ends it");

	const upload = await preview().evaluate(async () => (await fetch("http://localhost:3001/upload", { "method": "POST", "body": new Uint8Array(700_000) })).text());

	assert.equal(upload, "POST 700000", "an upload of several pieces, whole");

	await session.page.keyboard.press("Control+C");
	await eventually("the service stopped", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node events-server.js" && run.state === "stopped") || undefined);
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.delete(api.Uri.file("/workspace/events-server.js"));
	});
});

// What a run read of the workspace is recorded (RUNNING.md, *A call's result*), as a preview's fetches are: by the path
// as the script wrote it — what a stand-in asks for — so a rule can give a run what an earlier one read.
test("record: a node service's reads of the workspace, kept to be given back", async () => {
	const workbench = session.workbench();
	const rates = "{ \"US\": 0.07, \"CA\": 0.13 }\n";

	await workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file("/workspace/rates.json"), new TextEncoder().encode(text));
		await api.workspace.fs.writeFile(api.Uri.file("/workspace/read-rates.js"), new TextEncoder().encode("const fs = require('fs');\nconst rates = JSON.parse(fs.readFileSync('rates.json', 'utf8'));\nsetInterval(() => console.log(Object.keys(rates).length), 300);\n"));
	}, rates);
	await session.terminal("node read-rates.js", { "fresh": true });

	const recorded = await eventually("the read, recorded", async () => (await session.request("capability.recorded", { "capability": "fs:read", "resource": "rates.json" }, 10_000)) ?? undefined);

	assert.equal(recorded.value, rates);
	await session.page.keyboard.press("Control+C");
	await eventually("the service stopped", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node read-rates.js" && run.state === "stopped") || undefined);
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.delete(api.Uri.file("/workspace/rates.json"));
		await api.workspace.fs.delete(api.Uri.file("/workspace/read-rates.js"));
	});
});

// The event sheet's tab (ARCHITECTURE.md, *Extension points* 4: a pane view, the event-sheet extension's): the open file's part of its
// game beside the code it's in — a rule a card around its function, its condition and action on their line, each
// behavior on its declaration — placed by the span references anchoring gives them, so they follow their code.
test("event sheet: its tab — a game's rule a card around its code, its condition and action on their line, its behaviors on theirs", async () => {
	const workbench = session.workbench();
	const root = "/workspace/sheet-game";
	const cells = () => workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-cell")].map((cell) => ({ "line": Number(cell.dataset.line), "text": cell.textContent })));

	await workbench.evaluate(async (dir) => {
		const { api } = globalThis.__editor;
		const write = async (path, text) => api.workspace.fs.writeFile(api.Uri.file(`${dir}/${path}`), new TextEncoder().encode(text));

		await api.workspace.fs.createDirectory(api.Uri.file(`${dir}/src`));
		await write("package.json", "{ \"name\": \"sheet-game\" }\n");
		await write("src/game.ts", [
			"import { query } from \"bitecs\";",
			"",
			"export const Position = { \"x\": new Float32Array(100), \"y\": new Float32Array(100) };",
			"export const Player = [];",
			"",
			"export function move(world) {",
			"\tfor (const eid of query(world, [Position, Player])) {",
			"\t\tif (Position.x[eid] > 10) {",
			"\t\t\tPosition.x[eid] = 0;",
			"\t\t}",
			"\t}",
			"}",
			""
		].join("\n"));
		await api.window.showTextDocument(api.Uri.file(`${dir}/src/game.ts`));
	}, root);

	try {
		await workbench.locator(".notes-margin-tab", { "hasText": "Event sheet" }).click();

		const shown = await eventually("the game beside its code", async () => {
			const now = await cells();

			return now.some((cell) => cell.text.includes("when")) && now.some((cell) => cell.text.includes("Player")) ? now : undefined;
		}, 60_000);
		const at = (text) => shown.find((cell) => cell.text.includes(text))?.line;

		assert.equal(at("behavior Position"), 2, "a behavior on its declaration");
		assert.match(shown.find((cell) => cell.line === 3)?.text ?? "", /behavior Player — a tag/u);
		assert.equal(at("when Position.x[eid] > 10"), 7, "a condition and its action, on their line");
		assert.match(await workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-group-label")].map((label) => label.textContent).join("|")), /move.*for each Position \+ Player/u, "the rule, a card around its function");

		// Two lines above: each follows its code.
		await workbench.evaluate(async (dir) => {
			const { api } = globalThis.__editor;
			const edit = new api.WorkspaceEdit();

			edit.insert(api.Uri.file(`${dir}/src/game.ts`), new api.Position(1, 0), "// one\n// two\n");
			await api.workspace.applyEdit(edit);
		}, root);
		await eventually("each part followed its code", async () => {
			const now = await cells();
			const line = (text) => now.find((cell) => cell.text.includes(text))?.line;

			return (line("behavior Position") === 4 && line("when Position.x[eid] > 10") === 9) || undefined;
		});
	} finally {
		await workbench.locator(".notes-margin-tab", { "hasText": "Margin" }).click();
		await workbench.evaluate(async (dir) => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
			await api.workspace.fs.delete(api.Uri.file(dir), { "recursive": true }).then(() => undefined, () => undefined);
		}, root);
	}
});

test("webview: a markdown preview", async () => {
	await session.terminal(`echo "# Tour" > TOUR.md`, { "fresh": true });
	await session.page.waitForTimeout(1000);
	await session.open("TOUR.md");
	await session.command("Markdown: Open Preview to the Side");
	await session.until("a webview", alive(/^webview:/u));
	await session.until("workbench ⇄ webview", hasLabel("workbench", /^webview:/u, /./u));
});

test("git review: a diff in the shell", async () => {
	await session.open("App.tsx");
	await session.append("// architecture tour");
	await session.page.keyboard.press("ControlOrMeta+s");
	await session.page.getByTitle("Expand changes panel").click();
	await session.page.waitForTimeout(1500);
	await session.page.getByText("App.tsx").last().click();
	await session.until("Code Hike", hasLabel("sw", "net:lighter.codehike.org", /./u), 30_000);

	// A modified file's cosmetic/semantic verdict, derived from the BABLR worker's cached parses: commit what's there,
	// change a committed file, and the cosmetic extension's verdict (editor.annotations.classify) parses the new version
	// into the cache (bablr IndexedDB) — a comment added, so a cosmetic change, marked.
	const parses = () => session.workbench().evaluate(() => new Promise((resolve) => {
		const open = indexedDB.open("bablr");

		open.onsuccess = () => {
			const request = open.result.transaction("cst").objectStore("cst").count();

			request.onsuccess = () => {
				resolve(request.result);
			};

			request.onerror = () => {
				resolve(0);
			};
		};

		open.onerror = () => {
			resolve(0);
		};
	}));
	const before = await parses();

	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/src/index.ts");

		await api.commands.executeCommand("editor.git.commit", "architecture tour");

		const text = new TextDecoder().decode(await api.workspace.fs.readFile(uri));

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text + "\n// reformatted\n"));
		await api.commands.executeCommand("sourceControl.refresh");
	});
	await eventually("the change's verdict, from parses the cache now keeps", async () => (await parses()) > before || undefined, 60_000);
	await eventually("the file marked cosmetic, by the cosmetic extension", async () => ((await session.execute("cosmetic.list"))?.["src/index.ts"] === "cosmetic" ? true : undefined), 60_000);

	// The edits typed above were recorded as edit history in silo's local/ (its own IndexedDB-backed mount), not in .git/.
	const history = await eventually("the edit history, in silo's local/", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const list = (path) => api.workspace.fs.readDirectory(api.Uri.file(path)).then((found) => found.map(([name]) => name), () => []);
		const kept = await list("/workspace/.silo/local/edit-history");

		return kept.length === 0 ? undefined : { "kept": kept, "git": [...await list("/workspace/.git/edit-history"), ...await list("/workspace/.git/bablr-automerge")] };
	}));

	assert.ok(history.kept.some((name) => name.endsWith(".bin")));
	assert.deepEqual(history.git, [], "nothing of the editor's left in .git/");
});

// VS Code's new windows are panels of the shell's dock (shell-dock.ts): an editor moved out lives on, its DOM in a
// blank frame of the shell, and comes back whichever side closes the window — VS Code (its editors restored to the
// main window) or the user (the panel closed).
test("dock: an editor moved into a new window lands in a panel of the shell's dock, and comes back", async () => {
	const { page } = session;
	const windows = page.locator("iframe[name^=\"vscode-window-\"]");
	const panel = page.locator(".dv-tab", { "hasText": "Editors" });
	const run = (command) => session.workbench().evaluate((id) => globalThis.__editor.api.commands.executeCommand(id), command);
	const editorsInWindow = () => windows.first().evaluate((frame) => frame.contentDocument?.querySelectorAll(".monaco-editor").length ?? 0).catch(() => 0);

	// (The git review's diff, still open over the editor region, would cover the dock's tabs.)
	if (await page.getByTitle("Close diff").isVisible()) {
		await page.getByTitle("Close diff").click();
	}

	await session.open("index.ts");
	await run("workbench.action.moveEditorToNewWindow");
	await eventually("the editor in a dock panel", async () => await windows.count() === 1 && await editorsInWindow() > 0);
	assert.equal(await panel.count(), 1, "its panel");

	// VS Code closes it: back into the main window, and the panel goes with the window.
	await run("workbench.action.restoreEditorsToMainWindow");
	await eventually("the window closed by VS Code", async () => await windows.count() === 0 && await panel.count() === 0);
	assert.ok(await session.workbench().locator(".tabs-container .tab", { "hasText": "index.ts" }).count() > 0, "the editor back in the main window");

	// The user closes it: the panel closed, the window gone from VS Code too.
	await run("workbench.action.moveEditorToNewWindow");
	await eventually("the editor in a dock panel again", async () => await windows.count() === 1 && await editorsInWindow() > 0);
	await panel.locator(".dv-default-tab-action").click();
	await eventually("the window closed by the user", async () => await windows.count() === 0 && await panel.count() === 0);
	assert.deepEqual(await session.conformance(), [], "nothing needs review");
});

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});
