/**
 * The workspace terminal — just-bash (a pure-TS bash interpreter) on the editor's own filesystem (terminal-fs.ts),
 * with `node` dispatched to a worker (terminal-node.ts / node-runner.ts). It IS the default terminal: the editor
 * registers this as the vendored backend's process factory (setTerminalProcessFactory, in workbench-entry), so
 * every terminal the workbench opens is this one — `> tsconfig.json` hits the read-only guard (permission denied)
 * and files the shell creates show up in the explorer.
 *
 * Session model — and DON'T "fix" the probe below thinking it's a workaround for using just-bash wrong: it is
 * stateless per `exec` BY DESIGN (it's an agent tool — each call is a one-shot, isolated, sandboxed run, so a
 * `cd`/`export` doesn't stick; only the filesystem, being external, persists). just-bash's OWN interactive shell
 * (`just-bash-shell`) has the identical limitation — it calls `Bash.exec(line)` exactly like we do, and `cd`/
 * `export` don't persist across its prompts either. There is no persistent-session API to use instead. So the
 * interactive session layer is ours to add: we hold cwd + env here and thread them through every `exec`. env
 * round-trips via the result (`BashExecResult.env` — the only state just-bash returns); cwd is read back with a
 * `$PWD` probe appended to each command — the same technique VS Code's own shell integration uses (emit `$PWD`
 * after each command), and semantically correct (it captures the top-level shell's final dir and respects
 * subshell isolation, which intercepting `cd` would not). One line editor, one prompt, sync input handling.
 */
import type { TerminalProcess } from "@brianjenkins94/monaco-vscode-api/main";

import type { NodeOutput, NodeRunner } from "./node-runner";
import { createWorkspaceTerminalFs } from "./terminal-fs";
import { createNodeCommand } from "./terminal-node";
import { createNpmCommand } from "./terminal-npm";

type VscodeApi = typeof import("vscode");

/** The persistent bits of just-bash's Bash we use (loaded lazily so its bundle stays off the boot path). */
type BashSession = {
	"exec": (commandLine: string, options: { "cwd": string; "env": Record<string, string> }) => Promise<{ "stdout": string; "stderr": string; "exitCode": number; "env": Record<string, string> }>;
};

const RS = ""; // record separator — frames the cwd/exit-code probe; ~never appears in real shell output
// Appended to every command: capture the user command's exit code, then emit `<RS>cwd<RS>rc<RS>` so we can read
// the working directory back (a `cd` has no other way to reach us) and the real exit code (printf would clobber $?).
const PROBE = `\n__jbrc=$?\nprintf '${RS}%s${RS}%s${RS}' "$PWD" "$__jbrc"`;
const PROBE_RE = new RegExp(`${RS}([^${RS}]*)${RS}([^${RS}]*)${RS}$`, "u");

/** Build the just-bash terminal process for one terminal. `fire` writes to the terminal; `cwd0` is the start dir. */
export function createBashProcess(api: VscodeApi, runner: NodeRunner, fire: (data: string) => void, cwd0: string): TerminalProcess {
	let sessionPromise: Promise<BashSession> | undefined;
	const getSession = (): Promise<BashSession> => {
		sessionPromise ??= import("just-bash/browser").then((module) => new module.Bash({ "fs": createWorkspaceTerminalFs(api), "customCommands": [createNodeCommand(runner, writeLive), createNpmCommand(getSession)] }) as unknown as BashSession);

		return sessionPromise;
	};

	let cwd = cwd0;
	let env: Record<string, string> = {};
	let line = "";
	let running = false;
	let inEscape = false;
	let controller: AbortController | undefined; // the running command's Ctrl-C handle
	let stdinBuffer = ""; // the line being typed into a running process's stdin (flushed on Enter)

	// terminals want CRLF; the shell emits LF.
	const write = (text: string): void => fire(text.replace(/\r?\n/gu, "\r\n"));
	// Live output from a streaming process (node): written to the terminal as it arrives, stderr in red.
	const writeLive: NodeOutput = (stream, data) => {
		const text = data.replace(/\r?\n/gu, "\r\n");

		fire(stream === "err" ? `[31m${text}[0m` : text);
	};
	const prompt = (): void => fire(`\r\n[1;36m${cwd}[0m $ `);

	const runLine = async (input: string): Promise<void> => {
		running = true;
		controller = new AbortController();
		const { signal } = controller;

		try {
			const session = await getSession();
			// `signal` is the shell's Ctrl-C: just-bash stops at the next statement boundary and forwards it to a
			// custom command's `ctx.signal` (so `node` kills its worker). An interrupted run may not reach the PROBE.
			const result = await session.exec(input + PROBE, { "cwd": cwd, "env": env, "signal": signal });

			let stdout = result.stdout;
			const match = PROBE_RE.exec(stdout);

			if (match !== null) {
				cwd = match[1] === "" ? cwd : match[1];
				stdout = stdout.slice(0, match.index);
			}

			env = result.env;

			// stdout then stderr, each with its trailing newline trimmed (the prompt supplies one), joined so the
			// two streams land on separate lines rather than run together. (A streamed `node` wrote its output
			// live and returns empty here.)
			const blocks: string[] = [];

			if (stdout !== "") {
				blocks.push(stdout.replace(/\n$/u, ""));
			}

			if (result.stderr !== "") {
				blocks.push(`[31m${result.stderr.replace(/\n$/u, "")}[0m`);
			}

			if (blocks.length > 0 && !signal.aborted) { // on Ctrl-C the output already streamed; skip abort noise
				write(blocks.join("\n"));
			}
		} catch (error) {
			if (!signal.aborted) { // an abort is the user's Ctrl-C, not a failure to report
				write(`[31m${error instanceof Error ? error.message : String(error)}[0m`);
			}
		} finally {
			running = false;
			controller = undefined;
			stdinBuffer = "";
			line = "";
			prompt();
		}
	};

	// While a process runs, keystrokes drive it, not the line editor: a foreground `node` process gets them as
	// stdin, and Ctrl-C interrupts whatever is running. Like a terminal in cooked mode we buffer a line locally
	// (with echo and backspace) and deliver it whole on Enter, so a `stdin.on('data')` reader sees a line at a
	// time rather than a byte per keystroke.
	const feedRunning = (data: string): void => {
		for (const character of data) {
			const code = character.charCodeAt(0);

			if (code === 0x03) { // Ctrl-C — interrupt the running command (kills a node worker)
				fire("^C\r\n");
				stdinBuffer = "";
				controller?.abort();

				return;
			}

			if (!runner.isRunning()) {
				continue; // a non-node command is running; only Ctrl-C reaches it
			}

			if (code === 0x0d || code === 0x0a) { // Enter → flush the buffered line into stdin
				fire("\r\n");
				runner.sendStdin(`${stdinBuffer}\n`);
				stdinBuffer = "";
			} else if (code === 0x7f || code === 0x08) { // Backspace — edit the buffer
				if (stdinBuffer !== "") {
					stdinBuffer = stdinBuffer.slice(0, -1);
					fire("\b \b");
				}
			} else if (code === 0x04) { // Ctrl-D: submit a partial line if any, else signal end-of-input (like a tty)
				if (stdinBuffer === "") {
					runner.endStdin();
				} else {
					runner.sendStdin(stdinBuffer);
					stdinBuffer = "";
				}
			} else if (code >= 0x20 || code === 0x09) { // printable / tab — echo and buffer
				fire(character);
				stdinBuffer += character;
			}
		}
	};

	const input = (data: string): void => {
		if (running) {
			feedRunning(data);

			return;
		}

		for (const character of data) {
			const code = character.charCodeAt(0);

			if (inEscape) {
				inEscape = !(code >= 0x40 && code <= 0x7e); // consume a CSI/escape sequence to its final byte
				continue;
			}

			if (code === 0x1b) {
				inEscape = true;
			} else if (code === 0x0d || code === 0x0a) { // Enter (CR from a terminal; LF from paste/automation)
				fire("\r\n");
				void runLine(line);

				return; // the rest of this chunk waits until the command finishes
			} else if (code === 0x7f || code === 0x08) { // Backspace
				if (line !== "") {
					line = line.slice(0, -1);
					fire("\b \b");
				}
			} else if (code === 0x03) { // Ctrl-C — abandon the current line
				fire("^C");
				line = "";
				prompt();
			} else if (code >= 0x20) { // printable
				line += character;
				fire(character);
			}
		}
	};

	const start = (): void => {
		void getSession(); // warm the bundle while the user reads the banner
		fire("[1mjust-bash[0m — an in-browser shell on the workspace filesystem\r\n");
		prompt();
	};

	return { "start": start, "input": input };
}
