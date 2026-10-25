/**
 * almostnode's `readline` and `readline/promises` (builtins.ts): lines read from the interface's `input`, as Node's are —
 * there's no port of Node's on npm (its readline is bound up with its terminal handling). unenv's answered every question
 * with "" and gave one empty line, whatever came in. Here a line is what comes before a `\n` (a `\r\n` too); each is a
 * `line` event, or the answer to the question asked; the iterator gives them as they come; and the input's end closes
 * the interface, with what was left after the last `\n` as its last line. What a terminal adds — keys, history,
 * completion, the cursor — isn't here (`terminal` is false): unenv's cursor functions stand in.
 */
import events from "events/events.js";

interface Input { "on": (event: string, listener: (...args: unknown[]) => void) => unknown; "removeListener": (event: string, listener: (...args: unknown[]) => void) => unknown; "resume"?: () => unknown; "pause"?: () => unknown }
interface Output { "write": (text: string) => unknown }
interface Options { "input"?: Input; "output"?: Output; "prompt"?: string; "crlfDelay"?: number; "terminal"?: boolean }

/** Whether `createInterface` was given the input itself (`createInterface(input, output)`), not its options. */
const isInput = (value: Input | Options | undefined): value is Input => typeof (value as Input | undefined)?.on === "function";

export class Interface extends (events as unknown as typeof import("node:events").EventEmitter) {
	public readonly terminal = false;
	public line = "";
	public closed = false;
	private readonly input: Input | undefined;
	private readonly output: Output | undefined;
	private promptText: string;
	private buffered = "";
	private readonly asked: ((answer: string) => void)[] = [];
	private readonly onData = (chunk: unknown): void => {
		this.feed(String(chunk));
	};
	private readonly onEnd = (): void => {
		this.close();
	};

	public constructor(input?: Input | Options, output?: Output) {
		super();

		const options: Options = isInput(input) ? { "input": input, "output": output } : input ?? {};

		this.input = options.input;
		this.output = options.output;
		this.promptText = options.prompt ?? "> ";
		this.input?.on("data", this.onData);
		this.input?.on("end", this.onEnd);
		this.input?.resume?.();
	}

	public getPrompt(): string {
		return this.promptText;
	}

	public setPrompt(prompt: string): void {
		this.promptText = prompt;
	}

	public prompt(): void {
		this.output?.write(this.promptText);
	}

	/** Ask: `query` written, and the next line its answer — not a `line` event. */
	public question(query: string, ...rest: unknown[]): void {
		const callback = rest.find((each): each is (answer: string) => void => typeof each === "function");

		this.output?.write(query);
		this.asked.push(callback ?? (() => undefined));
	}

	/** `data` as if it came in on the input. */
	public write(data: string): void {
		this.feed(data);
	}

	public pause(): this {
		this.input?.pause?.();
		this.emit("pause");

		return this;
	}

	public resume(): this {
		this.input?.resume?.();
		this.emit("resume");

		return this;
	}

	public close(): void {
		if (this.closed) {
			return;
		}

		// (what came after the last newline: its last line)
		if (this.buffered !== "") {
			const last = this.buffered;

			this.buffered = "";
			this.take(last);
		}

		this.closed = true;
		this.input?.removeListener("data", this.onData);
		this.input?.removeListener("end", this.onEnd);
		this.emit("close");
	}

	public getCursorPos(): { "rows": number; "cols": number } {
		return { "rows": 0, "cols": 0 };
	}

	/** The lines as they come, until the interface closes. */
	public async *[Symbol.asyncIterator](): AsyncGenerator<string> {
		const lines: string[] = [];
		let wake: (() => void) | undefined;
		const onLine = (line: string): void => {
			lines.push(line);
			wake?.();
		};
		const onClose = (): void => {
			wake?.();
		};
		const nextLine = (): Promise<void> => new Promise<void>((resolve) => {
			wake = resolve;
		});

		this.on("line", onLine);
		this.on("close", onClose);

		try {
			while (lines.length > 0 || !this.closed) {
				if (lines.length === 0) {
					await nextLine();
					wake = undefined;
					continue;
				}

				yield lines.shift() as string;
			}
		} finally {
			this.removeListener("line", onLine);
			this.removeListener("close", onClose);
		}
	}

	private feed(text: string): void {
		this.buffered += text;

		let end = this.buffered.indexOf("\n");

		while (end !== -1 && !this.closed) {
			const line = this.buffered.slice(0, end).replace(/\r$/u, "");

			this.buffered = this.buffered.slice(end + 1);
			this.take(line);
			end = this.buffered.indexOf("\n");
		}
	}

	private take(line: string): void {
		const answer = this.asked.shift();

		if (answer === undefined) {
			this.emit("line", line);
		} else {
			answer(line);
		}
	}
}

export function createInterface(input?: Input | Options, output?: Output): Interface {
	return new Interface(input, output);
}

/** `readline/promises`: the same, its question a promise of the answer. */
export const promises = {
	"Interface": class extends Interface {
		public override question(query: string): Promise<string> & void {
			return new Promise<string>((resolve) => {
				super.question(query, resolve);
			}) as Promise<string> & void;
		}
	},
	"createInterface": (input?: Input | Options, output?: Output): Interface => new promises.Interface(input, output)
};
