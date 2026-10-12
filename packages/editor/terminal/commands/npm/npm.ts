/**
 * The terminal's `npm` command — enough of npm to run package.json scripts and declare dependencies.
 *
 * `npm run <script>` (and the `npm start`/`test`/`stop`/`restart` shorthands) reads the nearest package.json and
 * re-runs the script string through the SAME just-bash session, so a script that calls `node …` hits the node
 * worker and the whole thing composes.
 *
 * `npm install [pkg…]` (and `ci`) declares dependencies in package.json — there is NO tarball fetch or node_modules:
 * the preview dev server resolves every declared dep from esm.sh at runtime (see frameworks/vite-dev-server.ts), so
 * a plain `npm install` is a no-op you never need, and `npm install lodash` just adds it to package.json (the
 * next preview load resolves it). The registry proper is still out of scope.
 *
 * `npm ls` lists what package.json declares; `npm run` with no script lists the scripts; `npm exec` / `npx` run a
 * command this shell has (`npx vite`) and say plainly when a package's own binary can't be (nothing's installed
 * locally to run). `pnpm` and `yarn` (../pnpm, ../yarn) are this npm, spoken in their words.
 */
import type { Command, ResolvedCommandContext } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { defineCommand } from "just-bash/browser";

const LIFECYCLE = new Set(["start", "stop", "test", "restart"]);
const INSTALL = new Set(["install", "i", "add", "ci"]);

/** The version `npm -v` answers: the npm that comes with the node almostnode's process reports (v20). */
const VERSION = "10.0.0";

interface Result { "stdout": string; "stderr": string; "exitCode": number }

/** Split a spec into name + version: `lodash` → latest, `lodash@4` → 4, `@scope/pkg@1` → 1 (scoped-name safe). */
function parseSpec(spec: string): { "name": string; "version": string } {
	const at = spec.lastIndexOf("@");

	return at > 0 ? { "name": spec.slice(0, at), "version": spec.slice(at + 1) } : { "name": spec, "version": "latest" };
}

/** Run a command line in the shell itself, where this one runs (`npm run`'s script, `npx`'s command). */
async function inShell(getSession: CommandHost["session"], line: string, ctx: ResolvedCommandContext, env: Record<string, string> = {}): Promise<Result> {
	const session = await getSession();
	const result = await session.exec(line, { "cwd": ctx.cwd, "env": { ...ctx.exportedEnv ?? Object.fromEntries(ctx.env), ...env }, "signal": ctx.signal });

	return { "stdout": result.stdout, "stderr": result.stderr, "exitCode": result.exitCode };
}

/** `npx <command> [args…]` / `npm exec`: run it if this shell has it; a package's own binary it can't. */
export async function exec(name: string, getSession: CommandHost["session"], args: string[], ctx: ResolvedCommandContext): Promise<Result> {
	const words = args.filter((argument, index) => !(argument.startsWith("-") && index === 0) && argument !== "--");
	const command = words[0];

	if (command === undefined) {
		return { "stdout": "", "stderr": `usage: ${name} <command> [args…]\n`, "exitCode": 1 };
	}

	const commands = ctx.getRegisteredCommands?.() ?? [];

	if (!commands.includes(command.replace(/@.*$/u, ""))) {
		return { "stdout": "", "stderr": `${name}: can't run ${command} here — packages aren't installed locally (the preview resolves them from esm.sh), so only this shell's own commands run (Tab lists them).\n`, "exitCode": 127 };
	}

	return inShell(getSession, [command.replace(/@.*$/u, ""), ...words.slice(1)].map((word) => (/^[\w./:=@%+-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(" "), ctx);
}

/** `npm …` itself: what `npm`, `pnpm` and `yarn` all run (`name` says which, in its messages). */
export async function npm(name: string, getSession: CommandHost["session"], args: string[], ctx: ResolvedCommandContext): Promise<Result> {
	const subcommand = args[0];

	if (subcommand === "-v" || subcommand === "--version") {
		return { "stdout": VERSION + "\n", "stderr": "", "exitCode": 0 };
	}

	if (subcommand === "exec" || subcommand === "x") {
		return exec(name, getSession, args.slice(1), ctx);
	}

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
		return { "stdout": "", "stderr": `${name} error: no package.json found\n`, "exitCode": 1 };
	}

		// ── ls: what package.json declares ─────────────────────────────────────────────────────────────────────
	if (subcommand === "ls" || subcommand === "list") {
		let pkg: { "name"?: string; "version"?: string; "dependencies"?: Record<string, string>; "devDependencies"?: Record<string, string> };

		try {
			pkg = JSON.parse(manifest) as typeof pkg;
		} catch {
			return { "stdout": "", "stderr": `${name} error: package.json is not valid JSON\n`, "exitCode": 1 };
		}

		const declared = [...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {}).map(([dependency, version]) => [dependency, version + " (dev)"] as const)];
		const lines = declared.map(([dependency, version], index) => `${index === declared.length - 1 ? "└──" : "├──"} ${dependency}@${version}`);

		return { "stdout": `${pkg.name ?? "(unnamed)"}${pkg.version === undefined ? "" : "@" + pkg.version} ${manifestPath.replace(/\/package\.json$/u, "")}\n${lines.length === 0 ? "└── (empty)" : lines.join("\n")}\n`, "stderr": "", "exitCode": 0 };
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
		return { "stdout": "", "stderr": `${name}: unsupported command '${subcommand ?? ""}' — this shell's ${name} installs (adds to package.json), lists (ls), runs scripts (run, start, test) and runs this shell's commands (exec)\n`, "exitCode": 1 };
	}

	let scripts: Record<string, string>;

	try {
		scripts = ((JSON.parse(manifest) as { "scripts"?: Record<string, string> }).scripts) ?? {};
	} catch {
		return { "stdout": "", "stderr": `${name} error: package.json is not valid JSON\n`, "exitCode": 1 };
	}

		// `npm run` alone lists the scripts, as npm does.
	if (script === undefined) {
		const entries = Object.entries(scripts);

		return { "stdout": entries.length === 0 ? "no scripts in package.json\n" : `scripts in ${manifestPath}:\n${entries.map(([each, line]) => `  ${each}\n    ${line}`).join("\n")}\n`, "stderr": "", "exitCode": 0 };
	}

	const command = scripts[script];

	if (command === undefined) {
		const available = Object.keys(scripts);
		const hint = available.length > 0 ? `\navailable scripts: ${available.join(", ")}` : "";

		return { "stdout": "", "stderr": `${name} error: Missing script: "${script}"${hint}\n`, "exitCode": 1 };
	}

	return inShell(getSession, scriptArgs.length > 0 ? `${command} ${scriptArgs.join(" ")}` : command, ctx, { "npm_lifecycle_event": script });
}

/** The `npm` command. A script runs in the shell itself (the host's `session`, created lazily — see ../../index.ts), with
 *  the shell's Ctrl-C forwarded so it reaches a long-running script (`npm run dev` → the blocking `vite` command). */
export function create({ session }: CommandHost): Command {
	return defineCommand("npm", async (args, ctx) => npm("npm", session, args, ctx));
}
