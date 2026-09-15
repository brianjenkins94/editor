/**
 * The terminal's `npm` command — enough of npm to run package.json scripts and declare dependencies.
 *
 * `npm run <script>` (and the `npm start`/`test`/`stop`/`restart` shorthands) reads the nearest package.json and
 * re-runs the script string through the SAME just-bash session, so a script that calls `node …` hits the node
 * worker and the whole thing composes.
 *
 * `npm install [pkg…]` declares dependencies in package.json — there is NO tarball fetch or node_modules: the
 * preview dev server resolves every declared dep from esm.sh at runtime (see frameworks/vite-dev-server.ts), so
 * a plain `npm install` is a no-op you never need, and `npm install lodash` just adds it to package.json (the
 * next preview load resolves it). The registry proper is still out of scope.
 */
import type { CustomCommand } from "just-bash/browser";
import { defineCommand } from "just-bash/browser";

const LIFECYCLE = new Set(["start", "stop", "test", "restart"]);
const INSTALL = new Set(["install", "i", "add"]);

/** Re-enter the shell to run a script line — the lazily-created Bash session (see terminal.ts). */
export type ShellRunner = () => Promise<{ "exec": (commandLine: string, options: { "cwd": string; "env": Record<string, string> }) => Promise<{ "stdout": string; "stderr": string; "exitCode": number; "env": Record<string, string> }> }>;

/** Split a spec into name + version: `lodash` → latest, `lodash@4` → 4, `@scope/pkg@1` → 1 (scoped-name safe). */
function parseSpec(spec: string): { "name": string; "version": string } {
	const at = spec.lastIndexOf("@");

	return at > 0 ? { "name": spec.slice(0, at), "version": spec.slice(at + 1) } : { "name": spec, "version": "latest" };
}

/** The `npm` command. `getSession` re-enters the shell to run the resolved script. */
export function createNpmCommand(getSession: ShellRunner): CustomCommand {
	return defineCommand("npm", async (args, ctx) => {
		const subcommand = args[0];

		// Nearest package.json: cwd, then the workspace root. Shared by install and run.
		const candidates = [`${ctx.cwd.replace(/\/$/u, "")}/package.json`, "/workspace/package.json"];
		let manifestPath: string | undefined;
		let manifest: string | undefined;

		for (const path of candidates) {
			try {
				manifest = await ctx.fs.readFile(path);
				manifestPath = path;
				break;
			} catch { /* try the next */ }
		}

		if (manifest === undefined || manifestPath === undefined) {
			return { "stdout": "", "stderr": "npm error: no package.json found\n", "exitCode": 1 };
		}

		// ── install: declare deps (no fetch — the preview resolves them from esm.sh) ──────────────────────────
		if (subcommand !== undefined && INSTALL.has(subcommand)) {
			const specs = args.slice(1).filter((argument) => !argument.startsWith("-"));

			if (specs.length === 0) {
				return { "stdout": "  Dependencies resolve on the fly from esm.sh — no install step needed.\n  Run `npm run dev` to start the preview.\n", "stderr": "", "exitCode": 0 };
			}

			let pkg: { "dependencies"?: Record<string, string> };

			try {
				pkg = JSON.parse(manifest) as { "dependencies"?: Record<string, string> };
			} catch {
				return { "stdout": "", "stderr": "npm error: package.json is not valid JSON\n", "exitCode": 1 };
			}

			pkg.dependencies ??= {};
			const added: string[] = [];

			for (const spec of specs) {
				const { name, version } = parseSpec(spec);

				pkg.dependencies[name] = version;
				added.push(`${name}@${version}`);
			}

			await ctx.fs.writeFile(manifestPath, `${JSON.stringify(pkg, null, "\t")}\n`);

			return { "stdout": `  + ${added.join("\n  + ")}\n  added to package.json — resolved from esm.sh on the next preview load.\n`, "stderr": "", "exitCode": 0 };
		}

		// ── run / lifecycle: execute a package.json script ────────────────────────────────────────────────────
		let script: string | undefined;
		let scriptArgs: string[];

		if (subcommand === "run" || subcommand === "run-script") {
			script = args[1];
			scriptArgs = args.slice(2);
		} else if (subcommand !== undefined && LIFECYCLE.has(subcommand)) {
			script = subcommand;
			scriptArgs = args.slice(1);
		} else {
			return { "stdout": "", "stderr": `npm: unsupported command '${subcommand ?? ""}' — this shell supports install and run/start/test\n`, "exitCode": 1 };
		}

		if (script === undefined) {
			return { "stdout": "", "stderr": "usage: npm run <script>\n", "exitCode": 1 };
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
