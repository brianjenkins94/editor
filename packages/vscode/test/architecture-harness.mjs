/**
 * Drives a real editor session in a fresh headless Chromium for the architecture tests, and reads what the live
 * architecture view observed (`globalThis.__architecture` in the workbench realm — see architecture-view.ts).
 *
 * Uses the dev server at ARCH_URL (default http://localhost:5173/), starting `tsx dev.ts` if nothing answers. Needs
 * a Chromium: Playwright's own, else CHROME_PATH, else the newest one in Playwright's browser cache. A developer's
 * own debug-mcp on :7378 is kept out (it may be an older build); `debugMcp: true` starts this checkout's instead.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as fs from "@brianjenkins94/util/fs";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";
import { relayWebSocket } from "@brianjenkins94/util/playwright/relay";
import { until } from "@brianjenkins94/util/until";

export const URL_UNDER_TEST = process.env.ARCH_URL ?? "http://localhost:5173/";
export const TIMEOUT_MS = 120_000;
/** Where the page's debug-mcp socket (:7378) is relayed to: this checkout's debug-mcp (`debugMcp: true` starts one; with
 *  `debugMcp: "external"` the test runs its own there — e.g. in-process, to read its store). */
export const DEBUG_MCP_PORT = 7399;

async function reachable(url) {
	try {
		return (await fetch(url)).ok;
	} catch {
		return false;
	}
}

/** Spawn `command` and resolve once its output contains `ready`. */
async function startProcess(command, args, cwd, ready) {
	// Its own process group, so close() can stop what npx starts under it (tsx → the dev server), not just npx: an
	// orphaned dev server keeps :5173, and the next session's starts beside it on another port.
	const child = spawn(command, args, { "cwd": cwd, "stdio": ["pipe", "pipe", "pipe"], "detached": true });

	// In CI there's no one to watch it: what the dev server / debug-mcp says is the only clue when a session won't boot.
	if (process.env.CI !== undefined) {
		child.stdout.pipe(process.stderr);
		child.stderr.pipe(process.stderr);
	}

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { reject(new Error(command + " didn't start")); }, TIMEOUT_MS);
		const onData = (chunk) => {
			// Without colors stripped, Vite's "Local:" never matches where CI turns them on ("\e[1mLocal\e[22m:").
			if (stripVTControlCharacters(String(chunk)).includes(ready)) {
				clearTimeout(timer);
				resolve();
			}
		};

		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => { reject(new Error(command + " exited: " + code)); });
	});

	return child;
}

// ── snapshot queries ──────────────────────────────────────────────────────────────────────────────────────────

const matches = (pattern, value) => (pattern instanceof RegExp ? pattern.test(value) : pattern === value);

/** Every observed channel between `a` and `b` (either direction; ids or patterns). */
export function between(snapshot, a, b) {
	return snapshot.channels.filter((channel) => (matches(a, channel.a) && matches(b, channel.b)) || (matches(a, channel.b) && matches(b, channel.a)));
}

export const alive = (id) => (snapshot) => snapshot.nodes.some((node) => matches(id, node.id) && node.state === "alive");
export const hasLabel = (a, b, label) => (snapshot) => between(snapshot, a, b).some((channel) => Object.keys(channel.labels).some((name) => label.test(name)));

// ── the session ───────────────────────────────────────────────────────────────────────────────────────────────

export async function startSession(options = {}) {
	const processes = [];

	if (!await reachable(URL_UNDER_TEST)) {
		processes.push(await startProcess("npx", ["tsx", "dev.ts"], new URL("..", import.meta.url), "Local:"));
	}

	if (options.debugMcp === true) {
		processes.push(await startProcess("npx", ["tsx", "src/bin.ts", "--port", String(DEBUG_MCP_PORT)], new URL("../../debug-mcp/", import.meta.url), "listening"));
	}

	// (`chromium`: Playwright launch options for the browser — the performance suite's full build and eager measurement.)
	const browser = await launchChromium(options.chromium ?? {});
	const context = await browser.newContext({ "viewport": { "width": 1400, "height": 900 } });

	if (options.debugMcp === true || options.debugMcp === "external") {
		// The page's debug-mcp socket (:7378), relayed to this checkout's debug-mcp.
		await relayWebSocket(context, /:7378/u, `ws://localhost:${DEBUG_MCP_PORT}`);
	} else {
		await context.routeWebSocket(/:7378/u, (route) => { route.close(); });
	}

	const page = await context.newPage();

	if (process.env.CI !== undefined) {
		page.on("pageerror", (error) => { console.error("[page error]", error.message); });
		page.on("console", (message) => {
			if (message.type() === "error") {
				console.error("[page console]", message.text());
			}
		});
	}

	await page.goto(URL_UNDER_TEST);

	let snapshot;
	// Every hub's subscriptions over the whole session (a snapshot's are that moment's): a context that came and went
	// keeps what it served, as its node stays on the diagram once seen.
	const topologySeen = {};
	// Every node and channel over the whole session, likewise: a context's report is replaced by the next one under its
	// name (each debug run's worker reports as `debug-worker`), so a snapshot's are only what the last one said.
	const nodesSeen = new Map();
	const channelsSeen = new Map();
	const workbench = () => page.frames().find((frame) => frame.url().includes("/__vscode__/host.html"));

	/** Take the view's snapshot now, and keep what it's seen. */
	async function look() {
		const frame = workbench();

		if (frame === undefined || !await frame.evaluate(() => globalThis.__architecture !== undefined).catch(() => false)) {
			return undefined;
		}

		snapshot = await frame.evaluate(() => globalThis.__architecture.snapshot());

		for (const [hub, topology] of Object.entries(snapshot.topology)) {
			const known = topologySeen[hub] ?? { "subscriptions": [], "sites": {} };

			topologySeen[hub] = { "subscriptions": [...new Set([...known.subscriptions, ...topology.subscriptions])], "sites": { ...known.sites, ...topology.sites } };
		}

		for (const node of snapshot.nodes) {
			nodesSeen.set(node.id, node);
		}

		for (const channel of snapshot.channels) {
			channelsSeen.set(channel.id, channel);
		}

		return snapshot;
	}

	// A look every second all session long, so a context that comes and goes between a test's own looks (a debug run's
	// server) is seen all the same.
	const looking = setInterval(() => { void look().catch(() => undefined); }, 1000);

	looking.unref();
	page.on("close", () => { clearInterval(looking); });

	/** Poll what the view observed until `ready(snapshot)` holds. */
	async function observed(what, ready, timeoutMs = TIMEOUT_MS) {
		return until(what, async () => {
			const seen = await look();

			return seen !== undefined && ready(seen) ? seen : undefined;
		}, { "timeoutMs": timeoutMs, "intervalMs": 500, "sleep": (ms) => page.waitForTimeout(ms) });
	}

	// Preview windows float over the workbench (they live in the shell), so drive it by keyboard from a spot they
	// never cover: the side bar's title.
	async function focusWorkbench() {
		await workbench().locator(".part.sidebar .composite.title").first().click();
	}

	async function runCommand(title) {
		await page.keyboard.press("ControlOrMeta+Shift+P");
		await page.keyboard.type(title);
		await page.waitForTimeout(700);
		await page.keyboard.press("Enter");
	}

	return {
		"page": page,
		"workbench": workbench,
		"until": observed,
		"snapshot": () => snapshot,
		"topologySeen": () => topologySeen,
		/** Everything seen all session: the last snapshot, with every node and channel any look saw. */
		"seen": () => ({ ...snapshot, "nodes": [...nodesSeen.values()], "channels": [...channelsSeen.values()], "topology": topologySeen }),
		"conformance": async () => workbench().evaluate(() => globalThis.__architecture.conformance()),
		/** An RPC into the hub tree, from the workbench realm. */
		"request": async (subject, data, timeoutMs) => workbench().evaluate(([s, d, t]) => globalThis.__architecture.request(s, d, t), [subject, data, timeoutMs]),
		/** Type a command into a terminal: the current one, or a new one (the current may be busy with a server). */
		"terminal": async (command, { fresh = false } = {}) => {
			// The terminal is created on demand (it's off the boot path), so a session starts without one.
			const exists = await workbench().locator(".xterm").first().isVisible().catch(() => false);

			if (fresh || !exists) {
				await focusWorkbench();
				await runCommand("Terminal: Create New Terminal");
				await page.waitForTimeout(1500); // the new terminal takes focus
			} else {
				await workbench().locator(".xterm").first().click();
			}

			await page.keyboard.type(command);
			await page.keyboard.press("Enter");
		},
		/** Open a workspace file from the Explorer (quick open can't find the workspace's files). */
		"open": async (name) => {
			// A double click opens it pinned and focuses the editor (a preview window may be covering the editor area).
			await workbench().getByRole("treeitem", { "name": name, "exact": true }).first().dblclick();
			await page.waitForTimeout(1000);
		},
		/** Append a line to the end of the open editor. (Typed at the cursor — the top of the file — a comment would
		 *  land in front of the first import, and the newline after it accept a suggestion instead.) */
		"append": async (line) => {
			await page.keyboard.press("ControlOrMeta+End");
			await page.keyboard.type("\n" + line);
		},
		/** Run a command from the command palette by its title. */
		"command": async (title) => {
			await focusWorkbench();
			await runCommand(title);
		},
		"close": async (name) => {
			if (snapshot !== undefined) {
				fs.writeFileSync(path.join(fs.tmpdir(), name + ".json"), JSON.stringify(snapshot, null, "\t"));
			}

			await browser.close();

			for (const child of processes) {
				try {
					process.kill(-child.pid);
				} catch {
					// already gone
				}
			}
		}
	};
}
