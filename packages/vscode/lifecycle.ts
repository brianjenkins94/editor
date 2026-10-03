/**
 * Service or task: does a runnable keep running until it's stopped (a dev server, a watcher, anything that listens),
 * or run to completion (a build, a test run, a one-off script)? It decides how the editor runs it and shows it:
 *   • a package.json script that keeps running is a background task (extensions/running/tasks.ts), which the run
 *     picker groups as a service and offers its preview instead of a second copy;
 *   • `node <file>` runs a task under the tsval debugger (stepping, time travel, coverage) and a service under the
 *     real runtime — tsval has no event loop, so a server would just fall off the end of its file;
 *   • the running list (runs.ts) shows it, and a task's result when it ends.
 *
 * It's a guess from what's written — the command, the script's name, the file's source — so it's corrected by what a
 * run actually does: a task that opens a port is a service from then on (terminal-node.ts).
 */
export type Lifecycle = "service" | "task";

export interface LifecycleGuess {
	"lifecycle": Lifecycle;
	/** Why, in a few words: `runs a dev server`, `listens on a port`. */
	"reason": string;
}

/** Commands that serve or watch, whatever the script is called. (`vite build` builds; bare `vite`, `vite dev`,
 *  `vite preview` serve.) */
const SERVING_COMMANDS: [RegExp, string][] = [
	[/(?:^|[\s;&|])vite(?!\s+(?:build|optimize)\b)(?:\s|$)/u, "runs a dev server"],
	[/\b(?:next|nuxt|astro|remix|svelte-kit)\s+(?:dev|start|preview)\b/u, "runs a dev server"],
	[/\b(?:webpack|rspack)(?:-dev-server|\s+serve)\b/u, "runs a dev server"],
	[/\b(?:http-server|live-server|serve|nodemon)\b/u, "serves"],
	[/(?:^|\s)--watch(?:\s|=|$)|\b(?:tsx|tsc-watch|chokidar)\s+watch\b/u, "watches for changes"]
];

/** Script names that, by convention, start something that keeps running. */
const SERVICE_NAMES = /^(?:dev|start|serve|preview|watch)(?:[:-].*)?$/u;

/** What a file's source does that keeps a process alive. */
const SERVING_SOURCE: [RegExp, string][] = [
	[/\.listen\s*\(/u, "listens on a port"],
	[/\bcreateServer\s*\(/u, "starts a server"],
	[/\b(?:express|fastify|Koa)\s*\(\s*\)|new\s+Koa\s*\(/u, "starts a server"],
	[/new\s+WebSocketServer\s*\(/u, "starts a server"],
	[/\bsetInterval\s*\(/u, "runs on a timer"],
	[/process\.stdin\.(?:on|resume|setRawMode)\s*\(|readline\.createInterface\s*\(/u, "reads input"]
];

/** A package.json script: its command first (what it runs), then its name (what it's called). */
export function lifecycleOfScript(name: string, command: string): LifecycleGuess {
	for (const [pattern, reason] of SERVING_COMMANDS) {
		if (pattern.test(command)) {
			return { "lifecycle": "service", "reason": reason };
		}
	}

	if (SERVICE_NAMES.test(name)) {
		return { "lifecycle": "service", "reason": `"${name}" usually keeps running` };
	}

	return { "lifecycle": "task", "reason": "runs to completion" };
}

/** A script file (`node server.js`, a package's bin), by what its source does. Comments don't count. */
export function lifecycleOfSource(source: string): LifecycleGuess {
	const code = source.replaceAll(/\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/.*$/gmu, "");

	for (const [pattern, reason] of SERVING_SOURCE) {
		if (pattern.test(code)) {
			return { "lifecycle": "service", "reason": reason };
		}
	}

	return { "lifecycle": "task", "reason": "runs to completion" };
}
