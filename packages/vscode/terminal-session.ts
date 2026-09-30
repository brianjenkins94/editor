/**
 * One command of the terminal's session over just-bash (see terminal.ts for why the session is ours to keep): run it
 * with the session's cwd + env, then read back what just-bash can't hand us itself — the cwd, from a `$PWD` probe
 * appended to the command, and the env, from the result.
 */

/** What a just-bash `Bash` offers us: one stateless `exec`. */
export interface BashSession {
	"exec": (commandLine: string, options: { "cwd": string; "env": Record<string, string>; "signal"?: AbortSignal }) => Promise<{ "stdout": string; "stderr": string; "exitCode": number; "env": Record<string, string> }>;
}

export interface SessionState {
	"cwd": string;
	"env": Record<string, string>;
}

const RS = "\u001e"; // record separator (ASCII RS) — frames the cwd/exit-code probe; ~never appears in real shell output
// Appended to every command: capture the user command's exit code, then emit `<RS>cwd<RS>rc<RS>` so we can read
// the working directory back (a `cd` has no other way to reach us) and the real exit code (printf would clobber $?).
const PROBE = `\n__jbrc=$?\nprintf '${RS}%s${RS}%s${RS}' "$PWD" "$__jbrc"`;
const PROBE_RE = new RegExp(`${RS}([^${RS}]*)${RS}([^${RS}]*)${RS}$`, "u");

/**
 * Run `input` in the session `state` (updated in place: cwd from the probe, env from the result) and return its
 * output (the probe stripped) and exit code.
 *
 * `PWD` is seeded from the session's cwd on every run: just-bash's `$PWD` comes from the env it's given, which beats
 * the `cwd` option — and an interrupted run (Ctrl-C) returns just-bash's DEFAULT env (`PWD=/home/user`), not the
 * session's, without ever reaching the probe. Adopting that env as is would send the next command's probe, and so the
 * prompt, to `/home/user`. (An interrupted run keeps the cwd it started in: its own `cd`s never reach us.)
 */
export async function execInSession(session: BashSession, state: SessionState, input: string, signal?: AbortSignal): Promise<{ "stdout": string; "stderr": string; "exitCode": number }> {
	const result = await session.exec(input + PROBE, { "cwd": state.cwd, "env": { ...state.env, "PWD": state.cwd }, ...signal === undefined ? {} : { "signal": signal } });
	let { stdout } = result;
	const match = PROBE_RE.exec(stdout);

	if (match !== null) {
		state.cwd = match[1] === "" ? state.cwd : match[1];
		stdout = stdout.slice(0, match.index);
	}

	state.env = result.env;

	// The command's own exit code, from the probe (the result's is the probe's printf); an interrupted run's, as is.
	return { "stdout": stdout, "stderr": result.stderr, "exitCode": match === null ? result.exitCode : Number(match[2]) };
}
