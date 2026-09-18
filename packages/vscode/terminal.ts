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
import { createViteCommand } from "./terminal-vite";

type VscodeApi = typeof import("vscode");

/** The persistent bits of just-bash's Bash we use (loaded lazily so its bundle stays off the boot path). */
interface BashSession {
	"exec": (commandLine: string, options: { "cwd": string; "env": Record<string, string> }) => Promise<{ "stdout": string; "stderr": string; "exitCode": number; "env": Record<string, string> }>;
}

const RS = ""; // record separator — frames the cwd/exit-code probe; ~never appears in real shell output
// Appended to every command: capture the user command's exit code, then emit `<RS>cwd<RS>rc<RS>` so we can read
// the working directory back (a `cd` has no other way to reach us) and the real exit code (printf would clobber $?).
const PROBE = `\n__jbrc=$?\nprintf '${RS}%s${RS}%s${RS}' "$PWD" "$__jbrc"`;
const PROBE_RE = new RegExp(`${RS}([^${RS}]*)${RS}([^${RS}]*)${RS}$`, "u");

/** Build the just-bash terminal process for one terminal. `fire` writes to the terminal; `cwd0` is the start dir. */
// Tab-completion candidates for the first word (command position): the custom commands (node/npm/vite) plus the
// just-bash builtins users actually reach for. just-bash exposes no command registry, so this is curated.
const COMMANDS = [
	"alias", "basename", "cat", "cd", "clear", "cp", "dirname", "echo", "env", "export", "false", "find", "grep",
	"head", "history", "ls", "mkdir", "more", "mv", "node", "npm", "printenv", "printf", "pwd", "rm", "rmdir",
	"sed", "seq", "sleep", "sort", "tail", "tee", "test", "touch", "true", "uniq", "unalias", "vite", "wc", "which"
];

/** The longest string that every item starts with (for extending a partial to the common prefix on Tab). */
function longestCommonPrefix(items: string[]): string {
	if (items.length === 0) {
		return "";
	}

	let prefix = items[0];

	for (const item of items) {
		while (!item.startsWith(prefix)) {
			prefix = prefix.slice(0, -1);
		}
	}

	return prefix;
}

export function createBashProcess(api: VscodeApi, runner: NodeRunner, fire: (data: string) => void, cwd0: string): TerminalProcess {
	let sessionPromise: Promise<BashSession> | undefined;
	const getSession = (): Promise<BashSession> => {
		sessionPromise ??= import("just-bash/browser").then((module) => new module.Bash({ "fs": createWorkspaceTerminalFs(api), "customCommands": [createNodeCommand(runner, writeLive), createNpmCommand(getSession), createViteCommand(runner, writeLive)] }) as unknown as BashSession);

		return sessionPromise;
	};

	let cwd = cwd0;
	let env: Record<string, string> = {};
	let line = "";
	let pos = 0; // cursor position within `line`
	let running = false;
	let inEscape = false;
	let esc = ""; // accumulates an in-progress escape sequence (arrow keys, Home/End, Delete…)
	const history: string[] = [];
	let histIndex = 0; // index into `history`; === history.length means the live, un-submitted line
	let draft = ""; // the live line, stashed while browsing history so ↓ can restore it
	let controller: AbortController | undefined; // the running command's Ctrl-C handle
	let stdinBuffer = ""; // the line being typed into a running process's stdin (flushed on Enter)

	// terminals want CRLF; the shell emits LF.
	const write = (text: string): void => { fire(text.replace(/\r?\n/gu, "\r\n")); };
	// Live output from a streaming process (node): written to the terminal as it arrives, stderr in red.
	const writeLive: NodeOutput = (stream, data) => {
		const text = data.replace(/\r?\n/gu, "\r\n");

		fire(stream === "err" ? `[31m${text}[0m` : text);
	};

	const prompt = (): void => { fire(`\r\n[1;36m${cwd}[0m $ `); };

	const runLine = async (input: string): Promise<void> => {
		running = true;
		controller = new AbortController();
		const { signal } = controller;

		try {
			const session = await getSession();
			// `signal` is the shell's Ctrl-C: just-bash stops at the next statement boundary and forwards it to a
			// custom command's `ctx.signal` (so `node` kills its worker). An interrupted run may not reach the PROBE.
			const result = await session.exec(input + PROBE, { "cwd": cwd, "env": env, "signal": signal });

			let { stdout } = result;
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
			pos = 0;
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

			if (code === 0x0D || code === 0x0A) { // Enter → flush the buffered line into stdin
				fire("\r\n");
				runner.sendStdin(`${stdinBuffer}\n`);
				stdinBuffer = "";
			} else if (code === 0x7F || code === 0x08) { // Backspace — edit the buffer
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

	// A small line editor over `line`/`pos` — cursor movement (←/→, Home/End, Ctrl-A/E), in-place insert/delete, and
	// ↑/↓ command history. Redraws are done with bare escapes: `\b` (cursor left), `\x1b[C` (cursor right),
	// `\x1b[0K` (erase to end of line). After an in-place edit we reprint the tail and step the cursor back onto it.
	const setLine = (next: string): void => {
		fire("\b".repeat(pos) + "\x1b[0K" + next); // cursor to start, erase to EOL, print the replacement
		line = next;
		pos = next.length;
	};
	const insert = (chars: string): void => {
		const tail = line.slice(pos);

		line = line.slice(0, pos) + chars + tail;
		fire(chars + tail + "\b".repeat(tail.length)); // print inserted text + tail, then back onto the insertion point
		pos += chars.length;
	};
	const backspace = (): void => {
		if (pos === 0) {
			return;
		}

		const tail = line.slice(pos);

		line = line.slice(0, pos - 1) + tail;
		pos -= 1;
		fire("\b" + tail + " " + "\b".repeat(tail.length + 1)); // move left, reprint tail over the gap, erase last cell, restore cursor
	};
	const deleteAt = (): void => {
		if (pos >= line.length) {
			return;
		}

		const tail = line.slice(pos + 1);

		line = line.slice(0, pos) + tail;
		fire(tail + " " + "\b".repeat(tail.length + 1));
	};
	const moveLeft = (): void => { if (pos > 0) { pos -= 1; fire("\b"); } };
	const moveRight = (): void => { if (pos < line.length) { fire("\x1b[C"); pos += 1; } };
	const moveHome = (): void => { if (pos > 0) { fire("\b".repeat(pos)); pos = 0; } };
	const moveEnd = (): void => { if (pos < line.length) { fire("\x1b[C".repeat(line.length - pos)); pos = line.length; } };
	const historyPrev = (): void => {
		if (histIndex === 0) {
			return;
		}

		if (histIndex === history.length) {
			draft = line; // leaving the live line — stash it so ↓ can come back
		}

		histIndex -= 1;
		setLine(history[histIndex]);
	};
	const historyNext = (): void => {
		if (histIndex >= history.length) {
			return;
		}

		histIndex += 1;
		setLine(histIndex === history.length ? draft : history[histIndex]);
	};

	// Resolve a (possibly relative) directory path against cwd, collapsing "." and ".." — for path completion.
	const resolveDir = (part: string): string => {
		const raw = part.startsWith("/") ? part : cwd.replace(/\/+$/u, "") + "/" + part;
		const segments: string[] = [];

		for (const segment of raw.split("/")) {
			if (segment === "" || segment === ".") {
				continue;
			}

			if (segment === "..") {
				segments.pop();
			} else {
				segments.push(segment);
			}
		}

		return "/" + segments.join("/");
	};

	// Tab completion (only at end of line — the common case). First word → command names; later words / anything
	// with a slash → filesystem entries under cwd. One match completes inline (dir → "/", else " "); several extend
	// to their common prefix, or list when there's nothing more to share.
	const complete = async (): Promise<void> => {
		if (running || pos !== line.length) {
			return;
		}

		const token = line.slice(line.lastIndexOf(" ") + 1); // the word being completed (may be "")
		const before = line.slice(0, line.length - token.length);
		const isCommand = before.trim() === "" && !token.includes("/");

		const slash = token.lastIndexOf("/");
		const dirPrefix = isCommand || slash === -1 ? "" : token.slice(0, slash + 1);
		const base = isCommand || slash === -1 ? token : token.slice(slash + 1);

		const matches: string[] = [];
		const isDir = new Map<string, boolean>();

		if (isCommand) {
			matches.push(...COMMANDS.filter((name) => name.startsWith(base)));
		} else {
			try {
				for (const [name, type] of await api.workspace.fs.readDirectory(api.Uri.file(resolveDir(dirPrefix)))) {
					if (name.startsWith(base)) {
						matches.push(name);
						isDir.set(name, (type & 2) === 2); // FileType.Directory bit
					}
				}
			} catch {
				return; // unreadable dir → nothing to offer
			}
		}

		matches.sort((a, b) => a.localeCompare(b));

		if (matches.length === 0) {
			fire("\x07"); // bell

			return;
		}

		if (matches.length === 1) {
			const only = matches[0];
			const suffix = isCommand ? " " : isDir.get(only) === true ? "/" : " ";

			setLine(before + dirPrefix + only + suffix);

			return;
		}

		const prefix = longestCommonPrefix(matches);

		if (prefix.length > base.length) {
			setLine(before + dirPrefix + prefix); // extend to the shared prefix; more to type

			return;
		}

		// Ambiguous with nothing more in common — list the candidates (dirs marked with "/"), then restore the line.
		fire("\r\n" + matches.map((name) => (isCommand || isDir.get(name) !== true ? name : name + "/")).join("  "));
		prompt();
		fire(line);
	};

	// Dispatch a completed escape sequence — the part AFTER the ESC, e.g. "[A" (up), "[3~" (delete), "OD" (left in
	// application-cursor mode). Anything unmapped (modified arrows like "[1;5C") is ignored rather than echoed.
	const handleEscape = (seq: string): void => {
		switch (seq) {
			case "[A": case "OA": { historyPrev(); break; }
			case "[B": case "OB": { historyNext(); break; }
			case "[C": case "OC": { moveRight(); break; }
			case "[D": case "OD": { moveLeft(); break; }
			case "[H": case "OH": case "[1~": case "[7~": { moveHome(); break; }
			case "[F": case "OF": case "[4~": case "[8~": { moveEnd(); break; }
			case "[3~": { deleteAt(); break; }
			default: break;
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
				esc += character;

				// The final byte of a CSI/SS3 sequence is a letter or `~` (0x40–0x7E); digits and `;` are parameters.
				// The introducer (`[` or `O`) is the first char and never terminates on its own.
				if (esc.length >= 2 && code >= 0x40 && code <= 0x7E) {
					inEscape = false;
					handleEscape(esc);
					esc = "";
				} else if (esc.length === 1 && esc !== "[" && esc !== "O") {
					inEscape = false; // not a sequence we track (bare ESC, etc.) — drop it
					esc = "";
				}

				continue;
			}

			if (code === 0x1B) { // ESC — begin an escape sequence
				inEscape = true;
				esc = "";
			} else if (code === 0x0D || code === 0x0A) { // Enter (CR from a terminal; LF from paste/automation)
				fire("\r\n");

				const command = line;

				if (command.trim() !== "" && history[history.length - 1] !== command) {
					history.push(command); // record for ↑/↓ (skip blanks and consecutive dupes)
				}

				histIndex = history.length;
				draft = "";
				void runLine(command);

				return; // the rest of this chunk waits until the command finishes
			} else if (code === 0x7F || code === 0x08) { // Backspace
				backspace();
			} else if (code === 0x03) { // Ctrl-C — abandon the current line
				fire("^C");
				line = "";
				pos = 0;
				histIndex = history.length;
				prompt();
			} else if (code === 0x01) { // Ctrl-A → start of line
				moveHome();
			} else if (code === 0x05) { // Ctrl-E → end of line
				moveEnd();
			} else if (code === 0x09) { // Tab → complete the current word (command or path)
				void complete();
			} else if (code >= 0x20) { // printable — insert at the cursor
				insert(character);
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
