import type { CommandDefinition } from "../../catalog";

export default {
	"name": "git",
	"summary": "The workspace's git: status, diff, log, add, restore, commit, branch.",
	"usage": "git status [-s] | diff [--staged] [path…] | log [--oneline] [-n N] | add <path…|.> | restore [--staged] <path…> | commit [-a] -m <message> | branch [name]"
} satisfies CommandDefinition;
