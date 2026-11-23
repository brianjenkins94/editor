type Stream = "stdout" | "stderr";

export function consoleOf(write: (stream: Stream, method: string, args: unknown[], indent: string) => void, now: () => number = () => performance.now()): Record<string, (...args: unknown[]) => void> {
	let indent = "";
	const counts = new Map<string, number>();
	const timers = new Map<string, number>();
	const said = (stream: Stream, method: string) => (...args: unknown[]): void => {
		write(stream, method, args, indent);
	};
	const log = said("stdout", "log");
	const elapsed = (label: string): string => `${label}: ${(now() - timers.get(label)!).toFixed(3)}ms`;

	return {
		"log": log,
		"info": said("stdout", "info"),
		"debug": said("stdout", "debug"),
		"dir": said("stdout", "dir"),
		"dirxml": said("stdout", "dirxml"),
		"table": said("stdout", "table"),
		"warn": said("stderr", "warn"),
		"error": said("stderr", "error"),
		"trace": said("stderr", "trace"),
		"assert": (condition?: unknown, ...args: unknown[]): void => {
			if (!condition) {
				said("stderr", "assert")(...typeof args[0] === "string" ? [`Assertion failed: ${args[0]}`, ...args.slice(1)] : ["Assertion failed", ...args]);
			}
		},
		"count": (label: unknown = "default"): void => {
			const name = String(label);

			counts.set(name, (counts.get(name) ?? 0) + 1);
			log(`${name}: ${String(counts.get(name))}`);
		},
		"countReset": (label: unknown = "default"): void => {
			counts.delete(String(label));
		},
		"time": (label: unknown = "default"): void => {
			const name = String(label);

			if (timers.has(name)) {
				said("stderr", "warn")(`Warning: Label '${name}' already exists for console.time()`);

				return;
			}

			timers.set(name, now());
		},
		"timeLog": (label: unknown = "default", ...data: unknown[]): void => {
			const name = String(label);

			if (!timers.has(name)) {
				said("stderr", "warn")(`Warning: No such label '${name}' for console.timeLog()`);

				return;
			}

			log(elapsed(name), ...data);
		},
		"timeEnd": (label: unknown = "default"): void => {
			const name = String(label);

			if (!timers.has(name)) {
				said("stderr", "warn")(`Warning: No such label '${name}' for console.timeEnd()`);

				return;
			}

			log(elapsed(name));
			timers.delete(name);
		},
		"group": (...label: unknown[]): void => {
			if (label.length > 0) {
				log(...label);
			}

			indent += "  ";
		},
		"groupCollapsed": (...label: unknown[]): void => {
			if (label.length > 0) {
				log(...label);
			}

			indent += "  ";
		},
		"groupEnd": (): void => {
			indent = indent.slice(2);
		},
		"clear": (): void => undefined
	};
}
