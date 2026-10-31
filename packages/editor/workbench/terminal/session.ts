/**
 * One command of the terminal's session over just-bash (see index.ts for why the session is ours to keep): run it
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
	/** The last statement's exit code, when a line runs a statement at a time (statementsOf): the next one's `$?`. */
	"status"?: number;
}

const RS = "\u001E"; // record separator (ASCII RS) — frames the cwd/exit-code probe; ~never appears in real shell output
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
	// (each exec is a shell of its own: the last statement's status is said again, so `node x; echo $?` says node's)
	const status = state.status === undefined || state.status === 0 ? "" : `(exit ${state.status})\n`;
	const result = adoptResult(state, await session.exec(status + input + PROBE, { "cwd": state.cwd, "env": { ...state.env, "PWD": state.cwd }, ...signal === undefined ? {} : { "signal": signal } }));

	state.status = result.exitCode;

	return result;
}

/** `execInSession`'s reading of a run's `result`: the cwd from its probe and its env into `state`; its own output and
 *  exit code out. */
function adoptResult(state: SessionState, result: Awaited<ReturnType<BashSession["exec"]>>): { "stdout": string; "stderr": string; "exitCode": number } {
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

/** Whether `input` names one of the `streaming` commands — those that write their output live, to the terminal as they
 *  run, rather than into just-bash's stdout, which it hands back only when the whole line's done: in a line with one,
 *  what the line printed before it would come after. (Which commands stream is the catalog's: catalog.ts.) */
function namesStreaming(input: string, streaming: ReadonlySet<string>): boolean {
	return input.split(/[\s;&|]+/u).some((word) => streaming.has(word));
}

/**
 * Whether `statement`'s output goes somewhere other than the terminal: into a pipe (`| tail`) or a file (`> out.txt`,
 * `&> log`), outside quotes. A streaming command's output there is handed back through the shell, as any command's,
 * rather than written live — or `node x 2>&1 | tail` gives `tail` nothing, and its error goes nowhere to be seen.
 * `2> err.txt` and `2>&1` alone move only stderr, so the output still goes to the terminal.
 */
export function outputCaptured(statement: string): boolean {
	let quote: "'" | "\"" | undefined;

	for (let index = 0; index < statement.length; index += 1) {
		const character = statement[index];
		const before = statement[index - 1];

		if (quote !== undefined) {
			if (character === "\\" && quote === "\"") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
		} else if (character === "\\") {
			index += 1;
		} else if (character === "'" || character === "\"") {
			quote = character;
		} else if (character === "|" && statement[index + 1] !== "|" && before !== "|") {
			return true;
		} else if (character === ">" && before !== ">" && (before === undefined || !/\d/u.test(before) || before === "1") && statement[index + 1] !== "&") {
			return true;
		}
	}

	return false;
}

/** First words a line run statement by statement would mean something else with: compound commands (their bodies span
 *  statements), and builtins that act on the line's shell itself (`exit` would end only its statement). */
const WHOLE = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "exit", "return", "exec", "trap", "set", "shopt", "source", ".", "eval"]);

/** How a statement is joined to the next: `;` (or a newline), `&&`, `||` — none after the last. */
export type Then = ";" | "&&" | "||" | "";

/** Whether what's at `index` would mean something else run statement by statement: a subshell, a group, a command
 *  substitution, a here-document, a background job. */
function runsWhole(input: string, index: number): boolean {
	const character = input[index];
	const next = input[index + 1];

	return "(){}`".includes(character) || (character === "<" && next === "<") || (character === "&" && next !== "&" && input[index - 1] !== "&" && input[index - 1] !== ">" && next !== ">");
}

/** What joins the statement ending at `index` to the next, if a statement ends there: `;` (or a newline), `&&`, `||`. */
function joinerAt(input: string, index: number): Then | undefined {
	const character = input[index];
	const next = input[index + 1];

	if (character === ";" || character === "\n") {
		return ";";
	}

	if (character === "&" && next === "&") {
		return "&&";
	}

	return character === "|" && next === "|" ? "||" : undefined;
}

/**
 * `input` as its top-level statements, each with what joins it to the next — so a line with a `streaming` command
 * (`node`) can be run a statement at a time, each one's output shown before the next runs. Undefined — run it whole —
 * when it has no streaming command, one statement, or anything a statement-by-statement run would change the meaning
 * of: a compound command or a subshell, a here-document, a background job, or a builtin that acts on the shell itself.
 */
export function statementsOf(input: string, streaming: ReadonlySet<string>): { "text": string; "then": Then }[] | undefined {
	if (!namesStreaming(input, streaming)) {
		return undefined;
	}

	const statements: { "text": string; "then": Then }[] = [];
	let start = 0;
	let quote: "'" | "\"" | undefined;

	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		const then = joinerAt(input, index);

		if (quote !== undefined) {
			if (character === "\\" && quote === "\"") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
		} else if (character === "\\") {
			index += 1;
		} else if (character === "'" || character === "\"") {
			quote = character;
		} else if (runsWhole(input, index)) {
			return undefined; // a subshell, a group, a command substitution, a here-document, a background job
		} else if (then !== undefined) {
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

	if (kept.length < 2 || kept.some((statement) => WHOLE.has(statement.text.trim().split(/\s+/u)[0]))) {
		return undefined;
	}

	kept[kept.length - 1].then = "";

	return kept;
}
