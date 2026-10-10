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

/** Commands that write their output live — to the terminal as they run — rather than into just-bash's stdout, which it
 *  hands back only when the whole line's done: in a line with one, what the line printed before it would come after. */
const STREAMING = /(?:^|[\s;&|])(?:node|npm|vite)(?=\s|$)/u;

/** First words a line run statement by statement would mean something else with: compound commands (their bodies span
 *  statements), and builtins that act on the line's shell itself (`exit` would end only its statement). */
const WHOLE = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "exit", "return", "exec", "trap", "set", "shopt", "source", ".", "eval"]);

/** How a statement is joined to the next: `;` (or a newline), `&&`, `||` — none after the last. */
export type Then = ";" | "&&" | "||" | "";

/**
 * `input` as its top-level statements, each with what joins it to the next — so a line with a streaming command (`node`)
 * can be run a statement at a time, each one's output shown before the next runs. Undefined — run it whole — when it has
 * no streaming command, one statement, or anything a statement-by-statement run would change the meaning of: a compound
 * command or a subshell, a here-document, a background job, or a builtin that acts on the shell itself.
 */
export function statementsOf(input: string): { "text": string; "then": Then }[] | undefined {
	if (!STREAMING.test(input)) {
		return undefined;
	}

	const statements: { "text": string; "then": Then }[] = [];
	let start = 0;
	let quote: "'" | "\"" | undefined;

	for (let index = 0; index < input.length; index += 1) {
		const character = input[index]!;
		const next = input[index + 1];

		if (quote !== undefined) {
			if (character === "\\" && quote === "\"") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}

			continue;
		}

		if (character === "\\") {
			index += 1;
		} else if (character === "'" || character === "\"") {
			quote = character;
		} else if ("(){}`".includes(character) || (character === "<" && next === "<") || (character === "&" && next !== "&" && input[index - 1] !== "&" && input[index - 1] !== ">" && next !== ">")) {
			return undefined; // a subshell, a group, a command substitution, a here-document, a background job
		} else if (character === ";" || character === "\n" || (character === "&" && next === "&") || (character === "|" && next === "|")) {
			const then: Then = character === "&" ? "&&" : character === "|" ? "||" : ";";

			statements.push({ "text": input.slice(start, index), "then": then });
			index += then.length - 1;
			start = index + 1;
		}
	}

	if (quote !== undefined) {
		return undefined;
	}

	statements.push({ "text": input.slice(start), "then": "" });

	const kept = statements.filter((statement) => statement.text.trim() !== "");

	if (kept.length < 2 || kept.some((statement) => WHOLE.has(statement.text.trim().split(/\s+/u)[0]!))) {
		return undefined;
	}

	kept[kept.length - 1]!.then = "";

	return kept;
}
