/**
 * What the architecture tour's shards share (architecture-tour-*.mjs): a session of their own each — `node --test` runs a
 * file in a process of its own, so this module's `session` is that file's — and what each saw, kept for the diagram of
 * the whole tour (architecture-diagram.mjs) in $TMPDIR/architecture-tour-seen/<shard>.json; and the helpers their tests
 * use.
 */
import * as path from "node:path";
import { after, before } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { until } from "@brianjenkins94/util/until";

import { alive, startSession } from "./architecture-harness.mjs";

const { channels, seenChannels } = await import("../shared/architecture-model.ts");

/** Where each shard keeps what its session saw. */
export const SEEN_DIR = path.join(fs.tmpdir(), "architecture-tour-seen");

let current;

/** This shard's session, once it's started (its methods, as the session it is). */
export const session = new Proxy({}, { "get": (_target, key) => current[key] });

/** A shard of the tour named `name`: a session with `options` (startSession's) before its tests; after them, what it
 *  saw kept for the diagram, the declared channels it didn't see printed, and the session closed. */
export function tour(name, options = {}) {
	before(async () => {
		current = await startSession(options);
		await current.until("the node worker", alive("node"));
	});

	after(async () => {
		if (current === undefined) {
			return;
		}

		// The end the same everywhere: no debug run still going (a program's server keeps its own up), so the diagram's
		// hubs still running at the end — whose components it lists — are the ones that always are.
		// (time-boxed: a run blocked on its stdin doesn't end, and must not hold the shard)
		await Promise.race([session.workbench().evaluate(() => globalThis.__editor.api.debug.stopDebugging()), session.page.waitForTimeout(10_000)]).catch(() => undefined);
		await session.until("no debug run going", (snapshot) => !snapshot.nodes.some((node) => node.id.startsWith("debug-worker") && node.state === "alive"), 30_000).catch(() => undefined);
		await session.until("a last look", () => true);
		await fs.mkdir(SEEN_DIR, { "recursive": true });
		fs.writeFileSync(path.join(SEEN_DIR, name + ".json"), JSON.stringify(session.seen()));

		const last = session.snapshot();
		const seen = seenChannels(last.channels.map((channel) => ({ ...channel, "labels": new Map(Object.entries(channel.labels)) })));

		console.log("declared channels not seen:\n  " + channels.filter((channel) => !seen.has(channel)).map((channel) => `${channel.a} ⇄ ${channel.b}`).join("\n  "));
		await session.close(name);
	});
}

/** Poll `probe` (in this process) until it's truthy, waiting the way the page does. */
export function eventually(what, probe, timeoutMs = 30_000) {
	return until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });
}

/** The Rules tree's rule rows (VS Code's own tree view, the capabilities extension's): each one's label, as shown. */
export function ruleRows(workbench) {
	return workbench.evaluate(() => {
		const pane = [...document.querySelectorAll(".pane")].find((each) => each.querySelector(".pane-header .title")?.textContent?.trim() === "Rules");

		return pane === undefined ? undefined : [...pane.querySelectorAll(".monaco-list-row[aria-level=\"2\"]")].map((row) => row.querySelector(".label-name")?.textContent ?? "");
	});
}

/** Open the listed rule `which` picks in the rule editor (the Rule view), as its row does: `silo.rules.open`. */
export function openRule(workbench, which) {
	return workbench.evaluate(async (pick) => {
		const { api } = globalThis.__editor;
		const listed = await api.commands.executeCommand("silo.rules.list");

		await api.commands.executeCommand("silo.rules.open", listed.find((each) => (pick === "broken" ? each.problem !== undefined : true)));
	}, which);
}
