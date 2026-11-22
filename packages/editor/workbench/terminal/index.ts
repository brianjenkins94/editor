/// <reference types="vite/client" />
import type { Hub } from "@brianjenkins94/hub";
import type { TerminalProcess } from "@brianjenkins94/monaco-vscode-api/main";

import type { NodeOutput, NodeRunner } from "../node-runner";
import type { CommandFactory, CommandHost } from "./catalog";
import type { BashSession, SessionState } from "./session";
import { serve } from "@brianjenkins94/hub";
import { COMMANDS, STREAMING } from "./catalog";
import { createWorkspaceTerminalFs } from "./fs";
import { commandExecuted, commandFinished, commandLine, commandStart, promptStart, workingDirectory } from "./integration";
import { toCommand } from "./invoke";
import { execInSession, outputCaptured, statementsOf } from "./session";

type VscodeApi = typeof import("vscode");

const implementations = import.meta.glob<CommandFactory>(["./commands/*/*.ts", "!./commands/*/command.ts", "!./commands/**/*.test.*"], { "import": "create" });

const BUILTINS = ["cd", "eval", "exit", "export", "read", "set", "source", "test", "type", "unset"];

let completions: string[] = [...BUILTINS, ...COMMANDS.map((command) => command.name)];

function longestCommonPrefix(items: string[]): string {
	if (items.length === 0) {
		return "";
	}

	let [prefix] = items;

	for (const item of items) {
		while (!item.startsWith(prefix)) {
			prefix = prefix.slice(0, -1);
		}
	}

	return prefix;
}

let terminalsOpened = 0;

const TAIL = 8000;

const tails = new Map<number, { "terminal": number; "command"?: string; "open": boolean; "text": string }>();

export const ESCAPES = /\u001B(?:\[[^A-Za-z@~]*[A-Za-z@~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[A-Z=>\\^_])/gu;

export function createBashProcess(api: VscodeApi, runner: NodeRunner, hub: Hub, show: (data: string) => void, cwd0: string): TerminalProcess {
	terminalsOpened += 1;

	const terminal = terminalsOpened;
	const tail: { "terminal": number; "open": boolean; "text": string } = { "terminal": terminal, "open": true, "text": "" };
	const fire = (data: string): void => {
		tail.text = (tail.text + data.replaceAll(ESCAPES, "").replaceAll("\r\n", "\n")).slice(-TAIL);
		show(data);
	};

	tails.set(terminal, tail);
	const state: SessionState = { "cwd": cwd0, "env": {} };
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

	const write = (text: string): void => {
		fire(text.replace(/\r?\n/gu, "\r\n"));
	};

	let captured = false;

	const writeLive: NodeOutput = (stream, data) => {
		const text = data.replace(/\r?\n/gu, "\r\n");

		fire(stream === "err" ? `[31m${text}[0m` : text);
	};

	let sessionPromise: Promise<BashSession> | undefined;
	const getSession = (): Promise<BashSession> => {
		sessionPromise ??= import("just-bash/browser").then((module) => {
			const host: CommandHost = { "history": {
				"lines": () => [...history],
				"clear": () => {
					history.length = 0;
					histIndex = 0;
				}
			}, "api": api, "runner": runner, "hub": hub, "writeLive": writeLive, "captured": () => captured, "terminal": terminal, "session": getSession };
			const theirs = new Set(module.getCommandNames());
			const commands = COMMANDS.map((command) => ({ "name": command.name, "load": async () => toCommand(command, command.notHere === undefined ? (await implementations[`./commands/${command.name}/${command.name}.ts`]())(host) : undefined) }));

			completions = [...new Set([...BUILTINS, ...theirs, ...COMMANDS.map((command) => command.name)])];

			return new module.Bash({ "fs": createWorkspaceTerminalFs(api), "customCommands": commands });
		});

		return sessionPromise;
	};

	const prompt = (): void => {
		fire(`\r\n${workingDirectory(state.cwd)}${promptStart()}[1;36m${state.cwd}[0m $ ${commandStart()}`);
	};

	const runLine = async (input: string): Promise<void> => {
		const abort = new AbortController();
		const { signal } = abort;

		running = true;
		controller = abort;
		const runs = input.trim() !== "";
		let exitCode = 0;

		if (runs) {
			fire(commandLine(input) + commandExecuted());
		}

		try {
			const session = await getSession();
			let fresh = true;
			const show = (result: { "stdout": string; "stderr": string }): void => {
				const blocks: string[] = [];

				if (result.stdout !== "") {
					blocks.push(result.stdout.replace(/\n$/u, ""));
				}

				if (result.stderr !== "") {
					blocks.push(`[31m${result.stderr.replace(/\n$/u, "")}[0m`);
				}

				if (blocks.length > 0 && !signal.aborted) { // on Ctrl-C the output already streamed; skip abort noise
					write((fresh ? "" : "\n") + blocks.join("\n"));
					fresh = false;
				}
			};

			const statements = statementsOf(input, STREAMING) ?? [{ "text": input, "then": "" as const }];

			for (let index = 0; index < statements.length && !signal.aborted; index += 1) {
				const joined = statements[index - 1]?.then;
				const skipped = (joined === "&&" && exitCode !== 0) || (joined === "||" && exitCode === 0);

				if (!skipped) {
					if (!fresh) {
						write("\n");
						fresh = true;
					}

					captured = outputCaptured(statements[index].text);

					const result = await execInSession(session, state, statements[index].text, signal);

					({ exitCode } = result);
					show(result);
				}
			}
		} catch (error) {
			exitCode = 1;

			if (!signal.aborted) { // an abort is the user's Ctrl-C, not a failure to report
				write(`[31m${error instanceof Error ? error.message : String(error)}[0m`);
			}
		} finally {
			running = false;
			controller = undefined;
			stdinBuffer = "";
			line = "";
			pos = 0;
			fire(runs ? commandFinished(signal.aborted ? 130 : exitCode) : commandFinished());
			prompt();
		}
	};

	const feedRunning = (data: string): void => {
		for (const character of data) {
			const code = character.charCodeAt(0);

			if (code === 0x03) { // Ctrl-C — interrupt the running command (kills a node worker)
				fire("^C\r\n");
				stdinBuffer = "";
				controller?.abort();

				return;
			}

			if (runner.isRunning()) {
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
		}
	};

	const setLine = (next: string): void => {
		fire("\b".repeat(pos) + "\x1B[0K" + next); // cursor to start, erase to EOL, print the replacement
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

	const moveLeft = (): void => {
		if (pos > 0) {
			pos -= 1;
			fire("\b");
		}
	};

	const moveRight = (): void => {
		if (pos < line.length) {
			fire("\x1B[C");
			pos += 1;
		}
	};

	const moveHome = (): void => {
		if (pos > 0) {
			fire("\b".repeat(pos));
			pos = 0;
		}
	};

	const moveEnd = (): void => {
		if (pos < line.length) {
			fire("\x1B[C".repeat(line.length - pos));
			pos = line.length;
		}
	};

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

	const resolveDir = (part: string): string => {
		const raw = part.startsWith("/") ? part : state.cwd.replace(/\/+$/u, "") + "/" + part;
		const segments: string[] = [];

		for (const segment of raw.split("/")) {
			if (segment === "..") {
				segments.pop();
			} else if (segment !== "" && segment !== ".") {
				segments.push(segment);
			}
		}

		return "/" + segments.join("/");
	};

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
			await getSession(); // (just-bash's own command names come with it)
			matches.push(...completions.filter((name) => name.startsWith(base)));
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

		matches.sort((left, right) => left.localeCompare(right));

		if (matches.length === 0) {
			fire("\x07"); // bell

			return;
		}

		if (matches.length === 1) {
			const [only] = matches;
			const suffix = !isCommand && isDir.get(only) === true ? "/" : " ";

			setLine(before + dirPrefix + only + suffix);

			return;
		}

		const prefix = longestCommonPrefix(matches);

		if (prefix.length > base.length) {
			setLine(before + dirPrefix + prefix); // extend to the shared prefix; more to type

			return;
		}

		fire("\r\n" + matches.map((name) => (isCommand || isDir.get(name) !== true ? name : name + "/")).join("  "));
		prompt();
		fire(line);
	};

	const handleEscape = (seq: string): void => {
		switch (seq) {
			case "[A":
			case "OA": {
				historyPrev();
				break;
			}

			case "[B":
			case "OB": {
				historyNext();
				break;
			}

			case "[C":
			case "OC": {
				moveRight();
				break;
			}

			case "[D":
			case "OD": {
				moveLeft();
				break;
			}

			case "[H":
			case "OH":
			case "[1~":
			case "[7~": {
				moveHome();
				break;
			}

			case "[F":
			case "OF":
			case "[4~":
			case "[8~": {
				moveEnd();
				break;
			}

			case "[3~": {
				deleteAt();
				break;
			}

			default: break;
		}
	};

	const feedEscape = (character: string, code: number): void => {
		esc += character;

		if (esc.length >= 2 && code >= 0x40 && code <= 0x7E) {
			inEscape = false;
			handleEscape(esc);
			esc = "";
		} else if (esc.length === 1 && esc !== "[" && esc !== "O") {
			inEscape = false; // not a sequence we track (bare ESC, etc.) — drop it
			esc = "";
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
				feedEscape(character, code);
			} else if (code === 0x1B) { // ESC — begin an escape sequence
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
				fire("^C" + commandFinished()); // (finished without running, for shell integration)
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

	return {
		"start": start,
		"input": input,
		"shutdown": () => {
			tail.open = false;
			controller?.abort();
		}
	};
}

export function serveTerminalState(runner: NodeRunner, hub: Hub): void {
	serve(hub, "terminal.state", (args) => {
		const { terminal, lines = 50 } = (args ?? {}) as { "terminal"?: number; "lines"?: number };
		const runs = runner.runs.list();

		return [...tails.values()].filter((each) => terminal === undefined || each.terminal === terminal).map((each) => ({
			"terminal": each.terminal,
			"open": each.open,
			...each.command === undefined ? {} : { "command": each.command },
			"output": each.text.split("\n").slice(-Math.max(1, lines)).join("\n"),
			"runs": runs.filter((run) => "terminal" in run.origin && run.origin.terminal === each.terminal).map((run) => ({ "id": run.id, "title": run.title, "state": run.state }))
		}));
	});
}
