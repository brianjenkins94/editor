import type { CommandDefinition } from "../../catalog";

export default {
	"name": "pnpm",
	"summary": "This shell's npm, as pnpm says it: pnpm add, pnpm dev (a script by name), pnpm dlx.",
	// eslint-disable-next-line webawesome/no-html-in-strings -- "<script>" is the usage placeholder for a script's name, not markup
	"usage": "pnpm [install | add <package>… | <script> [args…] | run <script> | ls | dlx <command>]",
	"streaming": true
} satisfies CommandDefinition;
