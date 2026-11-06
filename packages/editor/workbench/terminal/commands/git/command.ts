import type { CommandDefinition } from "../../catalog";

const PATHS = { "format": Array, "default": [], "positional": "rest", "doc": "Paths (files or folders); none: all." } as const;

/** What this git doesn't do, as much as there's to say. */
const NOT_HERE = "isn't here: this git has status, diff, log, add, restore, commit, branch, switch and push.";
const NO_HISTORY_EDITS = "isn't here: nothing in this git rewrites or combines history. It has status, diff, log, add, restore, commit, branch, switch and push.";

export default {
	"name": "git",
	"subcommandsNotHere": {
		"merge": NO_HISTORY_EDITS,
		"rebase": NO_HISTORY_EDITS,
		"cherry-pick": NO_HISTORY_EDITS,
		"revert": NO_HISTORY_EDITS,
		"reset": "isn't here: git restore <path> undoes a file's changes, and git restore --staged <path> unstages it.",
		"stash": "isn't here: to put work aside, commit it on a branch (git switch -c <name>).",
		"rm": "isn't here: delete the file, and it's a change like any other.",
		"mv": "isn't here: rename the file, and it's a change like any other.",
		"clone": "isn't here: the top bar's GitHub button loads a repository.",
		"show": "isn't here: git log says what's been committed.",
		"blame": "isn't here: git log says what's been committed.",
		"fetch": "isn't here: the top bar's Commit pulls before it pushes.",
		"pull": "isn't here: the top bar's Commit pulls before it pushes.",
		"remote": NOT_HERE,
		"tag": NOT_HERE,
		"config": NOT_HERE,
		"init": NOT_HERE
	},
	"summary": "The workspace's git: status, diff, log, add, restore, commit, branch, switch, push.",
	"subcommands": {
		"status": { "summary": "What's changed: staged, not staged, untracked.", "options": { "short": { "format": Boolean, "default": false, "short": "s", "doc": "Two letters a file." } } },
		"diff": {
			"summary": "The changes against the last commit, as a unified diff.",
			"options": {
				"staged": { "format": Boolean, "default": false, "doc": "The staged changes." },
				"cached": { "format": Boolean, "default": false, "doc": "Same as --staged." },
				"paths": PATHS
			}
		},
		"log": {
			"summary": "The commits, newest first.",
			"numberIs": "maxCount",
			"options": {
				"oneline": { "format": Boolean, "default": false, "doc": "One line a commit." },
				"maxCount": { "format": String, "default": "", "short": "n", "doc": "At most this many." }
			}
		},
		"add": { "summary": "Stage changes.", "options": { "all": { "format": Boolean, "default": false, "short": "A", "doc": "Every change." }, "paths": PATHS } },
		"restore": { "summary": "Undo a file's changes, or unstage them (--staged).", "options": { "staged": { "format": Boolean, "default": false, "short": "S", "doc": "Unstage, keeping the changes." }, "paths": PATHS } },
		"commit": {
			"summary": "Commit what's staged.",
			"options": {
				"message": { "format": String, "default": "", "short": "m", "doc": "The message (there's no editor to write one in)." },
				"all": { "format": Boolean, "default": false, "short": "a", "doc": "Stage what's tracked first." },
				"amend": { "format": Boolean, "default": false, "doc": "Not here yet." }
			}
		},
		"branch": { "summary": "List the branches, or make one at HEAD.", "options": { "name": { "format": String, "default": "", "positional": true, "doc": "A branch to make." } } },
		"version": { "summary": "Which git this is.", "aliases": ["--version"] },
		"switch": {
			"summary": "Onto another branch; -c makes it at HEAD first, keeping your changes.",
			"options": { "create": { "format": Boolean, "default": false, "short": "c", "doc": "Make it first." }, "name": { "format": String, "default": "", "positional": true, "doc": "The branch." } }
		},
		"checkout": {
			"summary": "A branch, as switch does; -b makes it first. (A file's changes: git restore.)",
			"options": { "create": { "format": Boolean, "default": false, "short": "b", "doc": "Make it first." }, "name": { "format": String, "default": "", "positional": true, "doc": "The branch." } }
		},
		"push": {
			"summary": "Push a branch (the current one) to the GitHub repository this was loaded from — signed in with GitHub.",
			"options": {
				"force": { "format": Boolean, "default": false, "short": "f", "doc": "Even when it isn't a fast-forward." },
				"setUpstream": { "format": Boolean, "default": false, "short": "u", "doc": "Accepted: the branch is pushed as itself." },
				"remote": { "format": String, "default": "origin", "positional": true, "doc": "origin, the only one." },
				"branch": { "format": String, "default": "", "positional": true, "doc": "The branch; none: the current one." }
			}
		}
	}
} satisfies CommandDefinition;
