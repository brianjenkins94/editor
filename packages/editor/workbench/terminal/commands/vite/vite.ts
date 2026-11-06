/**
 * The terminal's `vite`: starts almostnode's dev server in the dev-server worker (real Vite can't run in a browser), says
 * its address, which opens a preview window, and blocks like a real dev server, streaming its hot updates, until Ctrl-C,
 * the running list's Stop or its last window closing. A
 * project's `"dev": "vite"` maps here, so `npm run dev` composes onto it.
 */
import type { CommandHost, Handler } from "../../catalog";

/** The first port. Concurrent `vite`s each claim the next free one, so their addresses and hot updates never collide. */
const BASE_PORT = 5173;
const inUse = new Set<number>();

function allocate(): number {
	let port = BASE_PORT;

	while (inUse.has(port)) {
		port += 1;
	}

	inUse.add(port);

	return port;
}

function stamp(): string {
	return new Date().toLocaleTimeString("en-US", { "hour12": false });
}

export function create({ runner, writeLive, terminal }: CommandHost): Handler {
	return async (_config, ctx) => {
		// One dev server per directory: a second `vite` here would only start a copy on the next port. Say where the first is.
		const serving = runner.runs.runningService((run) => run.cwd === ctx.cwd);

		if (serving !== undefined) {
			const where = "terminal" in serving.origin ? ` in terminal ${String(serving.origin.terminal)}` : "";

			return { "stdout": "", "stderr": `vite: ${ctx.cwd} is already being served${serving.port === undefined ? "" : ` on :${String(serving.port)}`}${where}\n`, "exitCode": 1 };
		}

		const port = allocate();
		// (`npm run` passes the script's name in the environment it runs it with: ctx.env, not the exported one)
		const event = Object.fromEntries(ctx.env)["npm_lifecycle_event"] ?? ctx.exportedEnv?.["npm_lifecycle_event"];
		let stop = (): void => { /* set once it's blocking */ };
		let restarting = false;
		// A service, in the running list, as it was asked for.
		const run = runner.runs.start({ "title": event === undefined ? "vite" : `npm run ${event}`, "kind": "service", "cwd": ctx.cwd, "origin": { "terminal": terminal }, "port": port, "entry": ctx.cwd, "runtime": "preview" }, () => {
			stop();
		}, () => {
			void restart();
		});
		// To its terminal, and to whoever's following the run (preview-session.ts).
		const say = (text: string): void => {
			writeLive("out", text);
			run.say(text);
		};

		const start = async (): Promise<void> => {
			say(`\n  VITE  dev server ready, in the browser, on ${ctx.cwd}\n\n  Local:  ${await runner.startDevServer(port, ctx.cwd)}\n\n`);
		};
		// Started over: the same run, on the same port, its windows closing as the old server goes and a window opening on the new.
		const restart = async (): Promise<void> => {
			restarting = true;
			say(`  ${stamp()} [vite] restarting\n`);
			await runner.stopDevServer(port);
			await start().catch((error: unknown) => {
				say(`vite: ${error instanceof Error ? error.message : String(error)}\n`);
				stop();
			});
			restarting = false;
		};

		try {
			await start();
		} catch (error) {
			inUse.delete(port);
			run.end(1, false);

			return { "stdout": "", "stderr": `vite: ${error instanceof Error ? error.message : String(error)}\n`, "exitCode": 1 };
		}

		const off = runner.onDevServerUpdate(port, (message) => {
			const update = message as { "type"?: string; "path"?: string };

			say(`  ${stamp()} [vite] ${update.type === "full-reload" ? "page reload" : "hmr update"} ${update.path ?? ""}\n`);
		});

		let offClosed = (): void => { /* set once it's blocking */ };

		await new Promise<void>((resolve) => {
			if (ctx.signal?.aborted === true) {
				resolve();

				return;
			}

			ctx.signal?.addEventListener("abort", () => {
				resolve();
			}, { "once": true });
			stop = resolve;
			offClosed = runner.onDevServerClosed(port, () => {
				if (!restarting) {
					resolve();
				}
			});
		});

		off();
		offClosed();
		await runner.stopDevServer(port);
		inUse.delete(port);
		say("\n  vite: dev server stopped\n");
		run.end(130, true);

		return { "stdout": "", "stderr": "", "exitCode": 130 };
	};
}
