/// <reference types="vite/client" />
import type { Hub } from "@brianjenkins94/hub";
import type { Juvy, Schema } from "@brianjenkins94/util/juvy";
import type { ResolvedCommandContext } from "just-bash/browser";
import type { NodeOutput, NodeRunner } from "../node-runner";
import type { BashSession } from "./session";

export interface CommandDefinition {
	"name": string;
	"summary": string;
	"options"?: Schema;
	"stopEarly"?: boolean;
	"subcommands"?: Record<string, SubcommandDefinition>;
	"streaming"?: boolean;
	"notHere"?: string;
	"subcommandsNotHere"?: Record<string, string>;
}

export interface SubcommandDefinition {
	"summary": string;
	"options"?: Schema;
	"stopEarly"?: boolean;
	"aliases"?: string[];
	"numberIs"?: string;
}

export interface CommandHost {
	"api": typeof import("vscode");
	"runner": NodeRunner;
	"hub": Hub;
	"writeLive": NodeOutput;
	"captured": () => boolean;
	"terminal": number;
	"session": () => Promise<BashSession>;
	"history": { "lines": () => string[]; "clear": () => void };
}

export interface CommandResult { "stdout": string; "stderr": string; "exitCode": number }

export type Handler = (config: Juvy, ctx: ResolvedCommandContext) => Promise<CommandResult>;

export type Implementation = Handler | Record<string, Handler>;

export type CommandFactory = (host: CommandHost) => Implementation;

const found = import.meta.glob<CommandDefinition>("./commands/*/command.ts", { "eager": true, "import": "default" });

export const COMMANDS: readonly CommandDefinition[] = Object.entries(found).map(([path, definition]) => {
	const folder = path.split("/").at(-2);

	if (definition.name !== folder) {
		throw new Error(`terminal: ${path} defines \`${definition.name}\` — a command's folder is its name`);
	}

	return definition;
}).sort((left, right) => left.name.localeCompare(right.name));

export const STREAMING: ReadonlySet<string> = new Set(COMMANDS.filter((command) => command.streaming === true).map((command) => command.name));
