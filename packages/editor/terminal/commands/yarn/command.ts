import type { CommandDefinition } from "../../catalog";

export default {
	"name": "yarn",
	"summary": "This shell's npm, as yarn says it: yarn (install), yarn add, yarn dev (a script by name), yarn dlx.",
	// eslint-disable-next-line webawesome/no-html-in-strings -- "<script>" is the usage placeholder for a script's name, not markup
	"usage": "yarn [add <package>… | <script> [args…] | run <script> | dlx <command>]",
	"streaming": true
} satisfies CommandDefinition;
