/**
 * Drives a real editor session in a fresh headless Chromium for the architecture tests, and reads what the live
 * architecture view observed (`globalThis.__architecture` in the workbench realm — see architecture-view.ts).
 *
 * Uses the dev server at ARCH_URL (default http://localhost:5173/), starting `tsx dev.ts` if nothing answers — once for
 * a whole run when it's the run's global setup (`node --test --test-global-setup=test/architecture-harness.mjs`), else
 * once per session. Needs
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
/** The realms a booted editor has (the smoke test's `boot`), and how long a session waits for them before giving up. */
const BOOT_REALMS = ["shell", "root", "sw", "workbench", "bridge", "node"];
const BOOT_TIMEOUT_MS = 90_000;

/** Where the page's debug-mcp socket (:7378) is relayed to: this checkout's debug-mcp (`debugMcp: true` starts one; with
 *  `debugMcp: "external"` the test runs its own there — e.g. in-process, to read its store). Suite files that run at the same
 *  time each want their own (`debugMcpPort`). */
export const DEBUG_MCP_PORT = 7399;

async function reachable(url) {
	try {
		return (await fetch(url)).ok;
	} catch {
		return false;
	}
}

/** Spawn `command` and resolve once its output contains `ready`. */
async function startProcess(command, args, cwd, ready, { echoStdout = true } = {}) {
	// Its own process group, so close() can stop what npx starts under it (tsx → the dev server), not just npx: an
	// orphaned dev server keeps :5173, and the next session's starts beside it on another port.
	const child = spawn(command, args, { "cwd": cwd, "stdio": ["pipe", "pipe", "pipe"], "detached": true });

	// In CI there's no one to watch it: what the dev server / debug-mcp says is the only clue when a session won't boot.
	// (`echoStdout: false`: a stdout that's a protocol — debug-mcp's is MCP's, a JSON-RPC message per line — isn't.)
	if (process.env.CI !== undefined) {
		if (echoStdout) {
			child.stdout.pipe(process.stderr);
		}

		child.stderr.pipe(process.stderr);
	}

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(command + " didn't start"));
		}, TIMEOUT_MS);
		const onData = (chunk) => {
			// Without colors stripped, Vite's "Local:" never matches where CI turns them on ("\e[1mLocal\e[22m:").
			if (stripVTControlCharacters(String(chunk)).includes(ready)) {
				clearTimeout(timer);
				resolve();
			}
		};

		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => {
			reject(new Error(command + " exited: " + code));
		});
	});

	return child;
}

// ── snapshot queries ──────────────────────────────────────────────────────────────────────────────────────────

const matches = (pattern, value) => (pattern instanceof RegExp ? pattern.test(value) : pattern === value);

/** Every observed channel between `one` and `other` (either direction; ids or patterns). */
export function between(snapshot, one, other) {
	return snapshot.channels.filter((channel) => (matches(one, channel.a) && matches(other, channel.b)) || (matches(one, channel.b) && matches(other, channel.a)));
}

export const alive = (id) => (snapshot) => snapshot.nodes.some((node) => matches(id, node.id) && node.state === "alive");
export const hasLabel = (one, other, label) => (snapshot) => between(snapshot, one, other).some((channel) => Object.keys(channel.labels).some((name) => label.test(name)));

// ── one dev server for a whole run ────────────────────────────────────────────────────────────────────────────

/** A resource that's missing by design, not by failure: the page's icon, and the `.d.ts` candidates the editor's type
 *  loader tries (module resolution asks for files that may not exist). Not counted among the page's errors. */
const EXPECTED_MISSES = [/\/favicon\.ico$/u, /\/workspace\/node_modules\/.+\.d\.ts(?:\?|$)/u];

/** A realm that couldn't load, as its starter says it (editor-api/failures' watchWorker): `[debug-worker] couldn't load: …`. */
const COULD_NOT_LOAD = /\[([\w-]+)\] couldn't load: /u;

/** The dev server the run's global setup started, if it had to: every suite file's sessions find it answering and use it. */
let runServer;

/** As `node --test`'s global setup: start the dev server once, before any suite file, unless one already answers. */
export async function globalSetup() {
	if (!await reachable(URL_UNDER_TEST)) {
		runServer = await startProcess("npx", ["tsx", "dev.ts"], new URL("..", import.meta.url), "Local:");
	}
}

/** As `node --test`'s global teardown: stop the dev server the setup started (one that already answered stays up). */
export async function globalTeardown() {
	try {
		if (runServer !== undefined) {
			process.kill(-runServer.pid);
		}
	} catch {
		// already gone
	}
}

/**
 * What a session that didn't boot was showing, kept as `architecture-boot-<time>.json` / `.png` in the temp folder (CI
 * uploads its `architecture-*` files when a run fails): every frame (its URL, how far it got, its first text, and whether
 * it's the workbench with its architecture view up), the service worker as Playwright and as the page see it, what the
 * page printed last, and a screenshot. Returns a few lines saying the same, for the error.
 */
async function bootDiagnostics(context, page, printed, missing) {
	const file = path.join(fs.tmpdir(), `architecture-boot-${Date.now()}`);
	const inFrame = async (frame, read) => frame.evaluate(read).catch((error) => ({ "unreadable": error.message.split("\n")[0] }));
	const frames = await Promise.all(page.frames().map(async (frame) => ({
		"url": frame.url(),
		"detached": frame.isDetached(),
		"state": await inFrame(frame, () => ({ "readyState": document.readyState, "crossOriginIsolated": globalThis.crossOriginIsolated, "architecture": globalThis.__architecture !== undefined, "text": document.body?.innerText.trim().slice(0, 300) ?? null }))
	})));
	const serviceWorker = await inFrame(page.mainFrame(), async () => ({
		"controller": navigator.serviceWorker?.controller?.scriptURL ?? null,
		"registrations": (await navigator.serviceWorker?.getRegistrations() ?? []).map((registration) => ({ "scope": registration.scope, "active": registration.active?.state ?? null, "installing": registration.installing?.state ?? null, "waiting": registration.waiting?.state ?? null }))
	}));
	const report = { "missing": missing, "url": page.url(), "workers": context.serviceWorkers().map((worker) => worker.url()), "serviceWorker": serviceWorker, "frames": frames, "printed": printed.slice(-60) };

	fs.writeFileSync(file + ".json", JSON.stringify(report, null, "\t"));
	await page.screenshot({ "path": file + ".png" }).catch(() => undefined);

	return [
		`Diagnostics: ${file}.json (and .png)`,
		`service worker: ${JSON.stringify(serviceWorker)} (Playwright sees ${report.workers.length === 0 ? "none" : report.workers.join(", ")})`,
		...frames.map((frame) => `frame ${frame.url || "(no url)"}${frame.detached ? " (detached)" : ""}: ${JSON.stringify(frame.state)}`),
		...printed.length === 0 ? ["the page printed nothing"] : ["the page's last lines:", ...printed.slice(-8).map((line) => "  " + line.slice(0, 300))]
	].join("\n");
}

// ── the session ───────────────────────────────────────────────────────────────────────────────────────────────

export async function startSession(options = {}) {
	const processes = [];

	if (!await reachable(URL_UNDER_TEST)) {
		processes.push(await startProcess("npx", ["tsx", "dev.ts"], new URL("..", import.meta.url), "Local:"));
	}

	const debugMcpPort = options.debugMcpPort ?? DEBUG_MCP_PORT;

	if (options.debugMcp === true) {
		processes.push(await startProcess("npx", ["tsx", "src/bin.ts", "--port", String(debugMcpPort)], new URL("../../debug-mcp/", import.meta.url), "listening", { "echoStdout": false }));
	}

	// (`chromium`: Playwright launch options for the browser — the performance suite's full build and eager measurement.)
	const browser = await launchChromium(options.chromium ?? {});
	const context = await browser.newContext({ "viewport": { "width": 1400, "height": 900 } });

	if (options.debugMcp === true || options.debugMcp === "external") {
		// The page's debug-mcp socket (:7378), relayed to this checkout's debug-mcp.
		await relayWebSocket(context, /:7378/u, `ws://localhost:${debugMcpPort}`);
	} else {
		await context.routeWebSocket(/:7378/u, (route) => {
			route.close();
		});
	}

	// (`prepare`: what a test sets up on the browser context before the page loads — a route answering for the site, say.)
	await options.prepare?.(context);

	const page = await context.newPage();
	// What went wrong in the page, kept to say why when the editor doesn't boot (and printed as it happens in CI).
	const pageErrors = [];
	// What the page printed lately — the root prints every record the hub tree collects ([source] text).
	const printed = [];
	// The same, less the bridge's file traffic (`runtime.fs`: thousands of lines as types load, which push everything else
	// out of `printed`): what a request that timed out says it was doing.
	const notable = [];
	// Who hears of a realm that couldn't load: each wait in progress, which fails on it at once (failFast).
	const realmFailed = new Set();

	page.on("pageerror", (error) => {
		pageErrors.push(error.message);

		if (process.env.CI !== undefined) {
			console.error("[page error]", error.message);
		}
	});
	page.on("console", (message) => {
		printed.push(message.text());

		if (printed.length > 5000) {
			printed.shift();
		}

		if (!message.text().includes("runtime.fs")) {
			notable.push(`${new Date().toISOString().slice(11, 23)} ${message.text().slice(0, 300)}`);

			if (notable.length > 5000) {
				notable.shift();
			}
		}

		if (message.type() === "error") {
			// (a resource that failed says only its status: where it was is the message's location)
			const { url } = message.location();
			const missing = message.text().startsWith("Failed to load resource");

			if (missing && EXPECTED_MISSES.some((expected) => expected.test(url))) {
				return;
			}

			const text = missing && url !== "" ? `${message.text()}: ${url}` : message.text();

			pageErrors.push(text);

			if (COULD_NOT_LOAD.test(text)) {
				for (const fail of realmFailed) {
					fail(text);
				}
			}

			if (process.env.CI !== undefined) {
				console.error("[page console]", text);
			}
		}
	});

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
	const looking = setInterval(() => {
		void look().catch(() => undefined);
	}, 1000);

	looking.unref();
	page.on("close", () => {
		clearInterval(looking);
	});

	/**
	 * `waiting`, unless a realm says it couldn't load meanwhile: then it fails at once, saying which and why. Whatever was
	 * awaited may come from that realm (a debug run's worker that never loaded never answers), and a wait that runs out
	 * its timeout says only that it timed out.
	 */
	function failFast(what, waiting) {
		let stop;
		const failed = new Promise((_resolve, reject) => {
			stop = (text) => {
				reject(new Error(`gave up waiting for ${what}: ${text.slice(text.search(COULD_NOT_LOAD))}`));
			};

			realmFailed.add(stop);
		});

		return Promise.race([waiting, failed]).finally(() => {
			realmFailed.delete(stop);
		});
	}

	/** Poll what the view observed until `ready(snapshot)` holds. */
	async function observed(what, ready, timeoutMs = TIMEOUT_MS) {
		return failFast(what, until(what, async () => {
			const seen = await look();

			return seen !== undefined && ready(seen) ? seen : undefined;
		}, { "timeoutMs": timeoutMs, "intervalMs": 500, "sleep": (ms) => page.waitForTimeout(ms) }));
	}

	/** Poll `probe` (in this process) until it's truthy, waiting the way the page does — failing fast as `observed` does. */
	function eventually(what, probe, timeoutMs = 30_000) {
		return failFast(what, until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => page.waitForTimeout(ms) }));
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

	async function shutdown() {
		await browser.close();

		// In CI, the session's errors once more, each once, where the failing tests are reported: said as they happened,
		// they're spread through everything else the run printed.
		if (process.env.CI !== undefined && pageErrors.length > 0) {
			const counts = new Map();

			for (const text of pageErrors) {
				counts.set(text, (counts.get(text) ?? 0) + 1);
			}

			console.error(`[page errors] this session's, ${counts.size} distinct:\n` + [...counts].map(([text, count]) => `  ${count === 1 ? "" : `×${count} `}${text}`).join("\n"));
		}

		for (const child of processes) {
			try {
				process.kill(-child.pid);
			} catch {
				// already gone
			}
		}
	}

	// Fail fast: a session whose editor didn't boot can pass nothing. Say so once, here — the suite's `before` throws and
	// its tests fail at once — not in every test's wait: a run whose extensions didn't load sat out each test's
	// 30–120 s timeout, 23 minutes in all. (`boot: false`: the performance suite, which times the boot itself.)
	if (options.boot !== false) {
		try {
			await observed("the editor's boot", (seen) => BOOT_REALMS.every((id) => alive(id)(seen)), BOOT_TIMEOUT_MS);
		} catch {
			const missing = BOOT_REALMS.filter((id) => snapshot === undefined || !alive(id)(snapshot));
			const errors = [...new Set(pageErrors)].slice(-8);
			const diagnostics = await bootDiagnostics(context, page, printed, missing).catch((error) => `(no diagnostics: ${error.message})`);

			await shutdown();
			throw new Error(`The editor didn't boot in ${BOOT_TIMEOUT_MS / 1000} s: ${missing.join(", ")} never came up.` + (errors.length === 0 ? "" : "\nThe page's errors:\n  " + errors.join("\n  ")) + "\n" + diagnostics);
		}
	}

	return {
		"page": page,
		"workbench": workbench,
		/** What the page printed lately: each line as the console has it — a collected record as `[source] text`. */
		"printed": () => printed,
		/** The same, less the bridge's file traffic (`runtime.fs`), each with the time it was printed. */
		"notable": () => notable,
		"until": observed,
		"eventually": eventually,
		"snapshot": () => snapshot,
		"topologySeen": () => topologySeen,
		/** Everything seen all session: the last snapshot, with every node and channel any look saw. */
		"seen": () => ({ ...snapshot, "nodes": [...nodesSeen.values()], "channels": [...channelsSeen.values()], "topology": topologySeen }),
		"conformance": async () => workbench().evaluate(() => globalThis.__architecture.conformance()),
		/** A command run, as an extension runs one: the editor's (EXTENSION-POINTS 5) or an extension's. */
		"execute": async (command, ...args) => workbench().evaluate(([name, given]) => globalThis.__editor.api.commands.executeCommand(name, ...given), [command, args]),
		/** An RPC into the hub tree, from the workbench realm. */
		// (a request that times out says what the page was saying about runs and debuggers meanwhile: the bridge logs each
		// step of a `debug.start`)
		"request": async (subject, data, timeoutMs) => workbench().evaluate(([sentSubject, sentData, sentTimeoutMs]) => globalThis.__architecture.request(sentSubject, sentData, sentTimeoutMs), [subject, data, timeoutMs]).catch((error) => {
			if (!/timed out/u.test(error.message)) {
				throw error;
			}

			const lines = notable.filter((line) => /debug|tsval|\brun|worker|error|couldn't/iu.test(line)).slice(-40);

			throw new Error(`${error.message}\nThe page's last lines about runs and debuggers:\n  ${lines.join("\n  ") || "(none)"}`, { "cause": error });
		}),
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
			// Revealed first — the Explorer's list draws only the rows in view, and other views share its height — then a double
			// click opens it pinned and focuses the editor (a preview window may be covering the editor area).
			await workbench().evaluate(async (file) => {
				const { api } = globalThis.__editor;
				const [found] = await api.workspace.findFiles(`**/${file}`, "**/node_modules/**", 1);

				if (found !== undefined) {
					await api.commands.executeCommand("revealInExplorer", found);
				}
			}, name);
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

			await shutdown();
		}
	};
}
