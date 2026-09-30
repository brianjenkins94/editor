/**
 * Drives a real editor session in a fresh headless Chromium for the architecture tests, and reads what the live
 * architecture view observed (`globalThis.__architecture` in the workbench realm — see architecture-view.ts).
 *
 * Uses the dev server at ARCH_URL (default http://localhost:5173/), starting `tsx dev.ts` if nothing answers. Needs
 * a Chromium: Playwright's own, else CHROME_PATH, else the newest one in Playwright's browser cache. A developer's
 * own debug-mcp on :7378 is kept out (it may be an older build); `debugMcp: true` starts this checkout's instead.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

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
			if (String(chunk).replaceAll(/\u001B\[[\d;]*m/gu, "").includes(ready)) {
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

function cachedChromium() {
	const cache = path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
	const candidates = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/u.test(name)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];

	for (const name of candidates) {
		for (const executable of [
			"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
			"chrome-linux/chrome",
			"chrome-linux64/chrome"
		]) {
			const candidate = path.join(cache, name, executable);

			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}

async function launch() {
	try {
		return await chromium.launch(process.env.CHROME_PATH === undefined ? {} : { "executablePath": process.env.CHROME_PATH });
	} catch (error) {
		const executablePath = cachedChromium();

		if (executablePath === undefined) {
			throw error;
		}

		return chromium.launch({ "executablePath": executablePath });
	}
}

/** Relay the page's debug-mcp socket (:7378) to this checkout's debug-mcp. */
async function bridgeDebugMcp(context) {
	await context.routeWebSocket(/:7378/u, (route) => {
		const upstream = new WebSocket(`ws://localhost:${DEBUG_MCP_PORT}`);
		const queued = [];

		upstream.addEventListener("open", () => {
			for (const message of queued.splice(0)) {
				upstream.send(message);
			}
		});
		upstream.addEventListener("message", (event) => { route.send(event.data); });
		upstream.addEventListener("close", () => { route.close(); });
		route.onMessage((message) => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(message);
			} else {
				queued.push(message);
			}
		});
		route.onClose(() => { upstream.close(); });
	});
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

	const browser = await launch();
	const context = await browser.newContext({ "viewport": { "width": 1400, "height": 900 } });

	if (options.debugMcp === true || options.debugMcp === "external") {
		await bridgeDebugMcp(context);
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
	const workbench = () => page.frames().find((frame) => frame.url().includes("/__vscode__/host.html"));

	/** Poll what the view observed until `ready(snapshot)` holds. */
	async function until(what, ready, timeoutMs = TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;

		for (;;) {
			const frame = workbench();

			if (frame !== undefined && await frame.evaluate(() => globalThis.__architecture !== undefined).catch(() => false)) {
				snapshot = await frame.evaluate(() => globalThis.__architecture.snapshot());

				if (ready(snapshot)) {
					return snapshot;
				}
			}

			if (Date.now() > deadline) {
				throw new Error("timed out waiting for " + what);
			}

			await page.waitForTimeout(500);
		}
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
		"until": until,
		"snapshot": () => snapshot,
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
				writeFileSync(path.join(tmpdir(), name + ".json"), JSON.stringify(snapshot, null, "\t"));
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
