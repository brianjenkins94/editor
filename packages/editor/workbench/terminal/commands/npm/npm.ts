/**
 * The terminal's `npm` command — enough of npm to run package.json scripts and declare dependencies.
 *
 * `npm run <script>` (and the `npm start`/`test`/`stop`/`restart` shorthands) reads the nearest package.json and
 * re-runs the script string through the SAME just-bash session, so a script that calls `node …` hits the node
 * worker and the whole thing composes.
 *
 * `npm install [pkg…]` (and `ci`) declares dependencies in package.json. A registry package is never fetched whole:
 * each place that loads one fetches what it needs as it's used, from the CDN, at the version `.silo/versions.json` (or its local copy) pins
 * (the preview dev server, the node_modules overlay, type acquisition). A plain `npm install` brings that file up to
 * the manifests and installs what the CDN can't serve — a `file:` dependency linked, a tarball URL unpacked
 * (workbench/install.ts) — as the editor does by itself when the project opens or a manifest changes.
 *
 * `npm ls` lists what package.json declares; `npm run` with no script lists the scripts; `npm exec` / `npx` run a
 * command this shell has (`npx vite`) and say plainly when a package's own binary can't be (nothing's installed
 * locally to run). `pnpm` and `yarn` (../pnpm, ../yarn) are this npm, spoken in their words.
 */
import type { ResolvedCommandContext } from "just-bash/browser";
import type { CommandHost, CommandResult, Handler } from "../../catalog";

/** The version `npm version` answers: the npm that comes with the node almostnode's process reports (v20). */
const VERSION = "10.0.0";

/** Split a spec into name + version: `lodash` → latest, `lodash@4` → 4, `@scope/pkg@1` → 1 (scoped-name safe). */
function parseSpec(spec: string): { "name": string; "version": string } {
	const at = spec.lastIndexOf("@");

	return at > 0 ? { "name": spec.slice(0, at), "version": spec.slice(at + 1) } : { "name": spec, "version": "latest" };
}

/** Run a command line in the shell itself, where this one runs (`npm run`'s script, `npx`'s command). */
async function inShell(getSession: CommandHost["session"], line: string, ctx: ResolvedCommandContext, env: Record<string, string> = {}): Promise<CommandResult> {
	const session = await getSession();
	const result = await session.exec(line, { "cwd": ctx.cwd, "env": { ...ctx.exportedEnv ?? Object.fromEntries(ctx.env), ...env }, "signal": ctx.signal });

	return { "stdout": result.stdout, "stderr": result.stderr, "exitCode": result.exitCode };
}

/** A word for a command line: as it is, or quoted. */
const quote = (word: string): string => (/^[\w./:=@%+-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** `npx <command> [args…]` / `npm exec`: run it if this shell has it; a package's own binary it can't. */
export async function exec(name: string, getSession: CommandHost["session"], words: string[], ctx: ResolvedCommandContext): Promise<CommandResult> {
	const [command, ...args] = words[0] === "--" ? words.slice(1) : words;

	if (command === undefined) {
		return { "stdout": "", "stderr": `${name}: which command? (${name} --help)\n`, "exitCode": 1 };
	}

	const bare = command.replace(/@.*$/u, "");

	if (!(ctx.getRegisteredCommands?.() ?? []).includes(bare)) {
		return { "stdout": "", "stderr": `${name}: can't run ${command} here — packages aren't installed locally (the preview resolves them from esm.sh), so only this shell's own commands run (Tab lists them).\n`, "exitCode": 127 };
	}

	return inShell(getSession, [bare, ...args].map(quote).join(" "), ctx);
}

/** The nearest package.json (the directory, then the workspace's) — or an error to report. */
async function manifestOf(name: string, ctx: ResolvedCommandContext): Promise<{ "path": string; "text": string } | CommandResult> {
	for (const path of [`${ctx.cwd.replace(/\/$/u, "")}/package.json`, "/workspace/package.json"]) {
		try {
			return { "path": path, "text": await ctx.fs.readFile(path) };
		} catch { /* try the next */ }
	}

	return { "stdout": "", "stderr": `${name} error: no package.json found\n`, "exitCode": 1 };
}

/** What npm reads of package.json. */
interface PackageJson {
	"name"?: string;
	"version"?: string;
	"scripts"?: Record<string, string>;
	"dependencies"?: Record<string, string>;
	"devDependencies"?: Record<string, string>;
}

/** package.json, parsed — or an error to report. */
function parsed(name: string, text: string): PackageJson | CommandResult {
	try {
		return JSON.parse(text) as PackageJson;
	} catch {
		return { "stdout": "", "stderr": `${name} error: package.json is not valid JSON\n`, "exitCode": 1 };
	}
}

const isResult = (value: unknown): value is CommandResult => typeof value === "object" && value !== null && "exitCode" in value;

/** A package.json script, run in the shell itself — or, with none named, the scripts listed (as npm does). */
async function runScript(name: string, getSession: CommandHost["session"], script: string, args: string[], ctx: ResolvedCommandContext): Promise<CommandResult> {
	const manifest = await manifestOf(name, ctx);

	if (isResult(manifest)) {
		return manifest;
	}

	const pkg = parsed(name, manifest.text);

	if (isResult(pkg)) {
		return pkg;
	}

	const scripts = pkg.scripts ?? {};

	if (script === "") {
		const entries = Object.entries(scripts);

		return { "stdout": entries.length === 0 ? "no scripts in package.json\n" : `scripts in ${manifest.path}:\n${entries.map(([each, line]) => `  ${each}\n    ${line}`).join("\n")}\n`, "stderr": "", "exitCode": 0 };
	}

	const command = scripts[script];

	if (command === undefined) {
		const available = Object.keys(scripts);

		return { "stdout": "", "stderr": `${name} error: Missing script: "${script}"${available.length > 0 ? `\navailable scripts: ${available.join(", ")}` : ""}\n`, "exitCode": 1 };
	}

	// (npm passes what comes after `--` to the script)
	const passed = args[0] === "--" ? args.slice(1) : args;

	return inShell(getSession, passed.length > 0 ? `${command} ${passed.map(quote).join(" ")}` : command, ctx, { "npm_lifecycle_event": script });
}

/** A plain `npm install`: `.silo/versions.json` brought up to the manifests, and what the CDN can't serve installed. */
async function installed(name: string, api: CommandHost["api"]): Promise<CommandResult> {
	const { installsLocally, syncVersions } = await import("../../../versions");
	const versions = await syncVersions(api);

	if (versions === undefined) {
		return { "stdout": "", "stderr": `${name}: the dependencies couldn't be resolved (the editor's log says why)\n`, "exitCode": 1 };
	}

	const entries = Object.entries(versions.packages);
	const linked = entries.filter(([, each]) => each.link !== undefined).map(([dependency, each]) => `  linked ${dependency} → ${each.link}\n`);
	const unpacked = entries.filter(([, each]) => each.link === undefined && installsLocally(each)).map(([dependency, each]) => `  unpacked ${dependency}@${each.version} from ${each.tarball}\n`);

	return { "stdout": `${linked.join("")}${unpacked.join("")}  ${entries.length} packages pinned in versions.json (.silo/, or .silo/local/ until the repository commits it); the rest load from the CDN as they're used.\n`, "stderr": "", "exitCode": 0 };
}

/** npm's subcommands, as `name` (npm, pnpm, yarn) says them in its messages. */
export function handlers(name: string, getSession: CommandHost["session"], api?: CommandHost["api"]): Record<string, Handler> {
	const lifecycle = (script: string): Handler => async (config, ctx) => runScript(name, getSession, script, config.get("args") as string[], ctx);

	return {
		"install": async (config, ctx) => {
			const specs = config.get("packages") as string[];

			if (specs.length === 0) {
				return api === undefined ? { "stdout": "  Dependencies resolve on the fly from esm.sh — no install step needed.\n  Run `npm run dev` to start the preview.\n", "stderr": "", "exitCode": 0 } : installed(name, api);
			}

			const manifest = await manifestOf(name, ctx);

			if (isResult(manifest)) {
				return manifest;
			}

			const pkg = parsed(name, manifest.text);

			if (isResult(pkg)) {
				return pkg;
			}

			const field = config.get("saveDev") === true ? "devDependencies" : "dependencies";
			const added: string[] = [];

			pkg[field] ??= {};

			for (const spec of specs) {
				const { "name": dependency, version } = parseSpec(spec);

				pkg[field][dependency] = version;
				added.push(`${dependency}@${version}`);
			}

			await ctx.fs.writeFile(manifest.path, `${JSON.stringify(pkg, null, "\t")}\n`);

			return { "stdout": `  + ${added.join("\n  + ")}\n  added to package.json${field === "devDependencies" ? " (dev)" : ""} — resolved from esm.sh on the next preview load.\n`, "stderr": "", "exitCode": 0 };
		},
		"uninstall": async (config, ctx) => {
			const names = config.get("packages") as string[];
			const manifest = await manifestOf(name, ctx);

			if (isResult(manifest)) {
				return manifest;
			}

			const pkg = parsed(name, manifest.text);

			if (isResult(pkg)) {
				return pkg;
			}

			const removed = names.filter((dependency) => (["dependencies", "devDependencies"] as const).some((field) => pkg[field]?.[dependency] !== undefined && delete pkg[field][dependency]));

			await ctx.fs.writeFile(manifest.path, `${JSON.stringify(pkg, null, "\t")}\n`);

			return { "stdout": removed.map((dependency) => `  - ${dependency}\n`).join(""), "stderr": names.filter((dependency) => !removed.includes(dependency)).map((dependency) => `${name}: ${dependency} isn't in package.json\n`).join(""), "exitCode": 0 };
		},
		"ls": async (_config, ctx) => {
			const manifest = await manifestOf(name, ctx);

			if (isResult(manifest)) {
				return manifest;
			}

			const pkg = parsed(name, manifest.text);

			if (isResult(pkg)) {
				return pkg;
			}

			const declared = [...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {}).map(([dependency, version]) => [dependency, version + " (dev)"] as const)];
			const lines = declared.map(([dependency, version], index) => `${index === declared.length - 1 ? "└──" : "├──"} ${dependency}@${version}`);

			return { "stdout": `${pkg.name ?? "(unnamed)"}${pkg.version === undefined ? "" : "@" + pkg.version} ${manifest.path.replace(/\/package\.json$/u, "")}\n${lines.length === 0 ? "└── (empty)" : lines.join("\n")}\n`, "stderr": "", "exitCode": 0 };
		},
		"run": async (config, ctx) => runScript(name, getSession, config.get("script") as string, config.get("args") as string[], ctx),
		"start": lifecycle("start"),
		"stop": lifecycle("stop"),
		"test": lifecycle("test"),
		"restart": lifecycle("restart"),
		"exec": async (config, ctx) => exec(name, getSession, config.get("command") as string[], ctx),
		"version": () => Promise.resolve({ "stdout": VERSION + "\n", "stderr": "", "exitCode": 0 })
	};
}

/** The `npm` command. A script runs in the shell itself (the host's `session`, created lazily — see ../../index.ts), with
 *  the shell's Ctrl-C forwarded so it reaches a long-running script (`npm run dev` → the blocking `vite` command). */
export function create({ session, api }: CommandHost): Record<string, Handler> {
	return handlers("npm", session, api);
}
