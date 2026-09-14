/**
 * The terminal's `npm` command — enough of npm to run package.json scripts. `npm run <script>` (and the
 * `npm start`/`test`/`stop`/`restart` shorthands) reads the nearest package.json and re-runs the script string
 * through the SAME just-bash session, so a script that calls `node …` hits the node worker and the whole thing
 * composes. Install / the registry are out of scope (a separate dependency-provisioning track).
 */
import type { CustomCommand } from "just-bash/browser";
import { defineCommand } from "just-bash/browser";

/** Re-enter the shell to run a script line — the lazily-created Bash session (see terminal.ts). */
export type ShellRunner = () => Promise<{ "exec": (commandLine: string, options: { "cwd": string; "env": Record<string, string> }) => Promise<{ "stdout": string; "stderr": string; "exitCode": number; "env": Record<string, string> }> }>;

const LIFECYCLE = new Set(["start", "stop", "test", "restart"]);

/** The `npm` command. `getSession` re-enters the shell to run the resolved script. */
export function createNpmCommand(getSession: ShellRunner): CustomCommand {
	return defineCommand("npm", async (args, ctx) => {
		let script: string | undefined;
		let scriptArgs: string[];

		if (args[0] === "run" || args[0] === "run-script") {
			script = args[1];
			scriptArgs = args.slice(2);
		} else if (args[0] !== undefined && LIFECYCLE.has(args[0])) {
			script = args[0];
			scriptArgs = args.slice(1);
		} else {
			return { "stdout": "", "stderr": `npm: unsupported command '${args[0] ?? ""}' — this shell supports run/start/test only (no install)\n`, "exitCode": 1 };
		}

		if (script === undefined) {
			return { "stdout": "", "stderr": "usage: npm run <script>\n", "exitCode": 1 };
		}

		// Nearest package.json: cwd, then the workspace root.
		const candidates = [`${ctx.cwd.replace(/\/$/u, "")}/package.json`, "/workspace/package.json"];
		let manifest: string | undefined;

		for (const path of candidates) {
			try {
				manifest = await ctx.fs.readFile(path);
				break;
			} catch { /* try the next */ }
		}

		if (manifest === undefined) {
			return { "stdout": "", "stderr": "npm error: no package.json found\n", "exitCode": 1 };
		}

		let scripts: Record<string, string>;

		try {
			scripts = ((JSON.parse(manifest) as { "scripts"?: Record<string, string> }).scripts) ?? {};
		} catch {
			return { "stdout": "", "stderr": "npm error: package.json is not valid JSON\n", "exitCode": 1 };
		}

		const command = scripts[script];

		if (command === undefined) {
			const available = Object.keys(scripts);
			const hint = available.length > 0 ? `\navailable scripts: ${available.join(", ")}` : "";

			return { "stdout": "", "stderr": `npm error: Missing script: "${script}"${hint}\n`, "exitCode": 1 };
		}

		const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env);
		const line = scriptArgs.length > 0 ? `${command} ${scriptArgs.join(" ")}` : command;
		const session = await getSession();
		const result = await session.exec(line, { "cwd": ctx.cwd, "env": { ...env, "npm_lifecycle_event": script } });

		return { "stdout": result.stdout, "stderr": result.stderr, "exitCode": result.exitCode };
	});
}
