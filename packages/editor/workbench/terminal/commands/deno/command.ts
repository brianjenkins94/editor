import type { CommandDefinition } from "../../catalog";

export default {
	"name": "deno",
	"summary": "Not here: node runs a program.",
	"notHere": "this shell's runtime is node: node <file> runs a program, npm run <script> a package.json script."
} satisfies CommandDefinition;
