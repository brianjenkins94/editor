/// <reference types="vite/client" />
/**
 * The terminal's own commands, found rather than listed: each is a folder under `commands/`, named after the command,
 * holding everything about it — `command.ts` (what it is: its name, a line saying what it does, whether it streams),
 * `<name>.ts` (the implementation, loaded the first time the command runs) and its tests. Adding a command is adding a
 * folder; everything that enumerates commands derives from here — tab completion, which commands make a line run a
 * statement at a time (session.ts), and the agent's `shell` tool's description (page-tools.ts) — so none of them is a
 * list to keep up by hand. (COMMANDS-AND-TOOLS.md has the layout and what's expected next.)
 *
 * Only `command.ts` is read here, eagerly — it's a few lines and imports nothing — so anything can ask what the
 * commands are without loading a command (index.ts loads the implementations, lazily).
 */
import type { Command } from "just-bash/browser";
import type { Hub } from "@brianjenkins94/hub";
import type { NodeOutput, NodeRunner } from "../node-runner";
import type { BashSession } from "./session";

/** What a command is: its `command.ts`'s default export. */
export interface CommandDefinition {
	/** The command's name, and its folder's. */
	"name": string;
	/** What it does, in a line: shown to people (`--help`) and to agents (the `shell` tool). */
	"summary": string;
	/** How it's called, for `--help`: `node <file> [args…]`. */
	"usage"?: string;
	/** It isn't here, and this says what to do instead (`vim` → the editor). Such a command has no implementation: it
	 *  says so and fails as a missing command does (127), so what people reach for out of habit is answered, not "not
	 *  found". */
	"missing"?: string;
	/** Its output goes to the terminal as it's produced rather than through just-bash's stdout (node, vite) — or it runs
	 *  lines that may (npm): a line with it runs a statement at a time, so what came before shows first (session.ts). */
	"streaming"?: boolean;
}

/** What a command's implementation is given: the terminal it runs in, and what it may use there. */
export interface CommandHost {
	"api": typeof import("vscode");
	"runner": NodeRunner;
	/** The workbench's hub: to say what a command changed (`git` → `git.changed`, so Source Control refreshes). */
	"hub": Hub;
	/** Write to this terminal now, as it's produced (stderr in red). */
	"writeLive": NodeOutput;
	/** This terminal's number: what it runs is attributed to it (runs.ts). */
	"terminal": number;
	/** The shell itself, to run a line in (`npm run` runs its script there). */
	"session": () => Promise<BashSession>;
	/** The lines typed at this terminal, oldest first (what ↑ walks back through). */
	"history": () => readonly string[];
}

/** A command's implementation: its `<name>.ts` exports `create`. */
export type CommandFactory = (host: CommandHost) => Command;

const found = import.meta.glob<CommandDefinition>("./commands/*/command.ts", { "eager": true, "import": "default" });

/** Every command, by name. A folder whose command has another name is a mistake, said at once. */
export const COMMANDS: readonly CommandDefinition[] = Object.entries(found).map(([path, definition]) => {
	const folder = path.split("/").at(-2);

	if (definition.name !== folder) {
		throw new Error(`terminal: ${path} defines \`${definition.name}\` — a command's folder is its name`);
	}

	return definition;
}).sort((left, right) => left.name.localeCompare(right.name));

/** The commands that are here (not `missing`). */
export const PRESENT: readonly CommandDefinition[] = COMMANDS.filter((command) => command.missing === undefined);

/** The commands that stream (see `CommandDefinition.streaming`). */
export const STREAMING: ReadonlySet<string> = new Set(COMMANDS.filter((command) => command.streaming === true).map((command) => command.name));

/** The commands as a sentence: `node` (…), `npm` (…) — and those that aren't here, so they aren't tried. */
export function describeCommands(): string {
	const missing = COMMANDS.filter((command) => command.missing !== undefined).map((command) => command.name);

	return PRESENT.map((command) => `\`${command.name}\` (${command.summary.replace(/\.$/u, "")})`).join(", ") + (missing.length === 0 ? "" : `. Not here: ${missing.join(", ")}`);
}

/** A command's `--help`: what it does and how it's called. */
export function helpOf(command: CommandDefinition): string {
	return `${command.summary}\n${command.usage === undefined ? "" : `\nusage: ${command.usage}\n`}`;
}
