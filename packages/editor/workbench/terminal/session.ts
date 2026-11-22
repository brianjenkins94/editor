export interface BashSession {
	"exec": (commandLine: string, options: { "cwd": string; "env": Record<string, string>; "signal"?: AbortSignal }) => Promise<{ "stdout": string; "stderr": string; "exitCode": number; "env": Record<string, string> }>;
}

export interface SessionState {
	"cwd": string;
	"env": Record<string, string>;
	"status"?: number;
}

const RS = "\u001E"; // record separator (ASCII RS) — frames the cwd/exit-code probe; ~never appears in real shell output
const PROBE = `\n__jbrc=$?\nprintf '${RS}%s${RS}%s${RS}' "$PWD" "$__jbrc"`;
const PROBE_RE = new RegExp(`${RS}([^${RS}]*)${RS}([^${RS}]*)${RS}$`, "u");

export async function execInSession(session: BashSession, state: SessionState, input: string, signal?: AbortSignal): Promise<{ "stdout": string; "stderr": string; "exitCode": number }> {
	const status = state.status === undefined || state.status === 0 ? "" : `(exit ${state.status})\n`;
	const result = adoptResult(state, await session.exec(status + input + PROBE, { "cwd": state.cwd, "env": { ...state.env, "PWD": state.cwd }, ...signal === undefined ? {} : { "signal": signal } }));

	state.status = result.exitCode;

	return result;
}

function adoptResult(state: SessionState, result: Awaited<ReturnType<BashSession["exec"]>>): { "stdout": string; "stderr": string; "exitCode": number } {
	let { stdout } = result;
	const match = PROBE_RE.exec(stdout);

	if (match !== null) {
		state.cwd = match[1] === "" ? state.cwd : match[1];
		stdout = stdout.slice(0, match.index);
	}

	state.env = result.env;

	return { "stdout": stdout, "stderr": result.stderr, "exitCode": match === null ? result.exitCode : Number(match[2]) };
}

function namesStreaming(input: string, streaming: ReadonlySet<string>): boolean {
	return input.split(/[\s;&|]+/u).some((word) => streaming.has(word));
}

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

const WHOLE = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "exit", "return", "exec", "trap", "set", "shopt", "source", ".", "eval"]);

export type Then = ";" | "&&" | "||" | "";

function runsWhole(input: string, index: number): boolean {
	const character = input[index];
	const next = input[index + 1];

	return "(){}`".includes(character) || (character === "<" && next === "<") || (character === "&" && next !== "&" && input[index - 1] !== "&" && input[index - 1] !== ">" && next !== ">");
}

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
