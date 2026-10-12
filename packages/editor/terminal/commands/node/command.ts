import type { CommandDefinition } from "../../catalog";

export default {
	"name": "node",
	"usage": "node <file> [args…]",
	"summary": "Run a program in the debugger, its output and input here.",
	"streaming": true
} satisfies CommandDefinition;
