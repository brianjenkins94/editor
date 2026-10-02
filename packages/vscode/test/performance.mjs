/**
 * Performance budgets: a real editor session in a fresh headless Chromium (architecture-harness.mjs), measured —
 *
 *  - `bootMs`: the page's start to the editor being ready;
 *  - `typedHoverMs`: opening the demo's App.tsx to a hover on `useState` that has its type;
 *  - `memoryMB.<realm>`: the tab's memory by realm at idle, from the metrics plane (the workbench's memory gauge, a
 *    reading taken after the hover — measured eagerly, so it's immediate and has every realm, TypeScript's servers too);
 *  - `repoLoadMs`: delivering a fixed, generated 1000-file project until its last file is in the workspace (generated,
 *    not this checkout's files, so the number doesn't drift as the repo grows).
 *
 * Each is checked against its budget in performance-budgets.json: over it fails. Against the last green run on main
 * (PERF_BASELINE, the `performance` artifact the workflow downloads), a rise past the budget's `warnAbove` share is a
 * warning, not a failure: shared runners are noisy, and a gate that flaps is worse than none. The results land in
 * $TMPDIR/performance.json (the workflow uploads it — the next run's baseline) and, in CI, the job summary.
 *
 *   node --test test/performance.mjs
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { after, before, test } from "node:test";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { until } from "@brianjenkins94/util/until";

import { startSession } from "./architecture-harness.mjs";

const budgets = JSON.parse(fs.readFileSync(new URL("performance-budgets.json", import.meta.url)));
const results = {};
let session;

// measureUserAgentSpecificMemory resolves only at a garbage collection — an idle editor on a CI runner went two minutes
// without one — and a reading taken early misses workers started since (TypeScript's servers, under the extension host:
// 10 realms one time, 16 the next). Eager, every reading is immediate and has every realm.
before(async () => { session = await startSession({ "chromiumArgs": ["--enable-blink-features=ForceEagerMeasureMemory"] }); });

after(async () => {
	report();
	await session?.close("architecture-performance"); // its architecture snapshot, beside the other suites' (not performance.json)
});

/** The workbench realm, once the editor is ready. */
async function editor() {
	const workbench = await until("the workbench", async () => {
		const frame = session.workbench();

		return frame !== undefined && await frame.evaluate(() => globalThis.__editor !== undefined).catch(() => false) ? frame : undefined;
	}, { "timeoutMs": 120_000, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });

	await workbench.evaluate(() => globalThis.__editor.ready);

	return workbench;
}

/** Record `value` under `name` (in the results, and the next run's baseline). */
function recorded(name, value) {
	results[name] = Math.round(value * 10) / 10;
}

/** Record `value` under `name` and hold it to its budget. */
function measured(name, value) {
	recorded(name, value);

	const budget = budgets[name];

	assert.ok(budget !== undefined, `${name} has no budget in performance-budgets.json`);
	assert.ok(value <= budget.max, `${name}: ${results[name]} is over its budget of ${budget.max}`);
}

test("boot: the page's start to the editor being ready", async () => {
	await editor();
	measured("bootMs", await session.page.evaluate(() => performance.now()));
});

test("the demo's first typed hover", async () => {
	const workbench = await editor();
	const ms = await workbench.evaluate(async () => {
		const api = globalThis.__editor.api;
		const uri = api.Uri.file("/workspace/src/App.tsx");
		const start = performance.now();
		const document = await api.workspace.openTextDocument(uri);

		await api.window.showTextDocument(document);

		const position = document.positionAt(document.getText().lastIndexOf("useState") + 1);

		while (performance.now() - start < 120_000) {
			const hovers = await api.commands.executeCommand("vscode.executeHoverProvider", uri, position);
			const text = (hovers ?? []).flatMap((hover) => hover.contents.map((content) => (typeof content === "string" ? content : content.value))).join(" ");

			// The syntax server answers first with a placeholder; the type is what's being timed.
			if (/useState[<(]/u.test(text) && !/loading/u.test(text)) {
				return performance.now() - start;
			}

			await new Promise((resolve) => { setTimeout(resolve, 100); });
		}

		return Infinity;
	});

	measured("typedHoverMs", ms);
});

test("memory by realm, at idle", async () => {
	const workbench = await editor();
	// The workbench's samples (none until the pod, which serves the command, has activated).
	const samples = async () => (await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.metrics.read")).catch(() => ({})))["workbench"] ?? [];
	const read = async () => (await samples()).filter((sample) => sample.values["memory.total"] !== undefined).at(-1)?.values;
	const before = (await read())?.["memory.total"];
	// What the gauge stands on, measured directly — so if no reading comes, the failure says why.
	const direct = await workbench.evaluate(async () => {
		const measure = performance.measureUserAgentSpecificMemory;
		const found = { "crossOriginIsolated": globalThis.crossOriginIsolated, "api": typeof measure };

		if (typeof measure === "function") {
			try {
				const result = await Promise.race([measure.call(performance), new Promise((_, reject) => { setTimeout(() => { reject(new Error("no answer in 10 s")); }, 10_000); })]);

				found.measured = Math.round(result.bytes / 1048576) + " MB in " + result.breakdown.length + " realms";
			} catch (error) {
				found.error = String(error);
			}
		}

		return found;
	});

	console.log("memory measurement, directly:", JSON.stringify(direct));

	// A new reading — the gauge takes one every 10 s — so one taken after the hover.
	const values = await until("a memory reading taken after the hover", async () => {
		const latest = await read();

		return latest !== undefined && latest["memory.total"] !== before ? latest : undefined;
	}, { "timeoutMs": 120_000, "intervalMs": 1000, "sleep": (ms) => session.page.waitForTimeout(ms) }).catch(async (error) => {
		const gauges = [...new Set((await samples()).flatMap((sample) => Object.keys(sample.values)))];

		throw new Error(error.message + " — measured directly: " + JSON.stringify(direct) + "; the workbench's gauges: " + (gauges.join(", ") || "none"));
	});

	// Every realm the reading has is recorded (the artifact shows them all); those with a budget are held to it.
	for (const [key, value] of Object.entries(values).filter(([key]) => key.startsWith("memory."))) {
		recorded("memoryMB." + key.slice("memory.".length), value);
	}

	for (const name of Object.keys(budgets).filter((budgeted) => budgeted.startsWith("memoryMB."))) {
		measured(name, results[name] ?? 0);
	}
});

test("loading a 1000-file project", async () => {
	const workbench = await editor();
	// Deterministic: 1000 TypeScript files, 40 directories, a couple of KB each.
	const files = Array.from({ "length": 1000 }, (_, index) => ({
		"path": `/workspace/perf/dir${index % 40}/file${index}.ts`,
		"contents": `export function f${index}(x: number): number {\n${"\treturn x + 1; // padding to a realistic size\n".repeat(40)}}\n`
	}));
	const ms = await workbench.evaluate(async (delivered) => {
		const api = globalThis.__editor.api;
		const last = api.Uri.file(delivered.at(-1).path);
		const start = performance.now();

		globalThis.__architecture.hub.publish("project.openFiles", { "files": delivered, "openEditors": [] });

		while (performance.now() - start < 120_000) {
			try {
				await api.workspace.fs.stat(last);

				return performance.now() - start;
			} catch {
				await new Promise((resolve) => { setTimeout(resolve, 50); });
			}
		}

		return Infinity;
	}, files);

	measured("repoLoadMs", ms);
});

/** Write the results, compare them with the last green run's, and — in CI — summarize them for the job. */
function report() {
	fs.writeFileSync(path.join(fs.tmpdir(), "performance.json"), JSON.stringify(results, null, "\t"));

	let baseline = {};

	try {
		baseline = JSON.parse(fs.readFileSync(process.env.PERF_BASELINE ?? ""));
	} catch { /* no baseline: the first run, or a local one */ }

	const rows = [];

	for (const [name, value] of Object.entries(results)) {
		const { max, warnAbove } = budgets[name] ?? {};
		const before = baseline[name];
		const change = typeof before === "number" && before > 0 ? (value - before) / before : undefined;

		if (change !== undefined && warnAbove !== undefined && change > warnAbove) {
			// A GitHub annotation, from any step's output.
			console.log(`::warning title=Performance::${name} rose ${Math.round(change * 100)}% since the last green run (${before} → ${value})`);
		}

		rows.push(`| ${name} | ${value} | ${before ?? "—"} | ${change === undefined ? "—" : (change >= 0 ? "+" : "") + Math.round(change * 100) + "%"} | ${max ?? "—"} |`);
	}

	if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Performance", "", "| | now | last green | change | budget |", "|---|---|---|---|---|", ...rows, ""].join("\n"));
	}

	console.log(["performance:", ...rows].join("\n"));
}
