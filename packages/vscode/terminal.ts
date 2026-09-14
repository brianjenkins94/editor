/**
 * The workspace terminal — a real VS Code terminal backed by just-bash (a pure-TS bash interpreter) running on
 * the editor's own filesystem via terminal-fs.ts. So `> tsconfig.json` hits the read-only guard (permission
 * denied) and files the shell creates show up in the explorer — see terminal-fs.ts for why.
 *
 * Wired as an extension `Pseudoterminal` (window.createTerminal({ pty })) rather than by replacing monaco's
 * default terminal backend — it keeps every dependency pointing the right way (this lives in packages/vscode and
 * imports the adapter; the vendored component would have to import UP into us).
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
 * subshell isolation, which intercepting `cd` would not). One line editor, one prompt, sync `handleInput`.
 */
import { createWorkspaceTerminalFs } from "./terminal-fs";

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

const ROOT = "/workspace";

/** Create the workspace terminal and reveal it. */
export function installTerminal(api: VscodeApi): void {
	const writeEmitter = new api.EventEmitter<string>();

	let sessionPromise: Promise<BashSession> | undefined;
	const getSession = (): Promise<BashSession> => {
		sessionPromise ??= import("just-bash/browser").then((module) => new module.Bash({ "fs": createWorkspaceTerminalFs(api) }) as unknown as BashSession);

		return sessionPromise;
	};

	let cwd = ROOT;
	let env: Record<string, string> = {};
	let line = "";
	let running = false;
	let inEscape = false;

	// terminals want CRLF; the shell emits LF.
	const write = (text: string): void => writeEmitter.fire(text.replace(/\r?\n/gu, "\r\n"));
	const prompt = (): void => writeEmitter.fire(`\r\n[1;36m${cwd}[0m $ `);

	const runLine = async (input: string): Promise<void> => {
		running = true;

		try {
			const session = await getSession();
			const result = await session.exec(input + PROBE, { "cwd": cwd, "env": env });

			let stdout = result.stdout;
			const match = PROBE_RE.exec(stdout);

			if (match !== null) {
				cwd = match[1] === "" ? cwd : match[1];
				stdout = stdout.slice(0, match.index);
			}

			env = result.env;
			stdout = stdout.replace(/\n$/u, ""); // the prompt supplies the trailing newline

			if (stdout !== "") {
				write(stdout);
			}

			if (result.stderr !== "") {
				write(`[31m${result.stderr.replace(/\n$/u, "")}[0m`);
			}
		} catch (error) {
			write(`[31m${error instanceof Error ? error.message : String(error)}[0m`);
		} finally {
			running = false;
			line = "";
			prompt();
		}
	};

	const pty: import("vscode").Pseudoterminal = {
		"onDidWrite": writeEmitter.event,
		"open": (): void => {
			void getSession(); // warm the bundle while the user reads the banner
			writeEmitter.fire("[1mjust-bash[0m — an in-browser shell on the workspace filesystem\r\n");
			prompt();
		},
		"close": (): void => undefined,
		"handleInput": (data: string): void => {
			if (running) {
				return; // v1: ignore input while a command runs
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
					writeEmitter.fire("\r\n");
					void runLine(line);

					return; // the rest of this chunk waits until the command finishes
				} else if (code === 0x7f || code === 0x08) { // Backspace
					if (line !== "") {
						line = line.slice(0, -1);
						writeEmitter.fire("\b \b");
					}
				} else if (code === 0x03) { // Ctrl-C — abandon the current line
					writeEmitter.fire("^C");
					line = "";
					prompt();
				} else if (code >= 0x20) { // printable
					line += character;
					writeEmitter.fire(character);
				}
			}
		}
	};

	const terminal = api.window.createTerminal({ "name": "bash", "pty": pty });

	terminal.show();

	// Localhost-only test seam: drive the pty's input directly and read back everything it wrote, so the line
	// editor + cwd/env persistence can be verified deterministically without xterm's keyboard plumbing. Never ships.
	if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
		let transcript = "";

		writeEmitter.event((text) => { transcript += text; });
		(globalThis as unknown as { "__term": unknown }).__term = {
			"input": (data: string): void => pty.handleInput?.(data),
			"read": (): string => transcript,
			"clear": (): void => { transcript = ""; }
		};
	}
}
