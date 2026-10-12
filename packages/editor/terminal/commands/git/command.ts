import type { CommandDefinition } from "../../catalog";

const PATHS = { "format": Array, "default": [], "positional": "rest", "doc": "Paths (files or folders); none: all." } as const;

export default {
	"name": "git",
	"summary": "The workspace's git: status, diff, log, add, restore, commit, branch.",
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
		"switch": { "summary": "Not here yet.", "missing": "switching branches isn't here yet — git branch lists them" },
		"checkout": { "summary": "Not here yet.", "missing": "switching branches isn't here yet — git restore <path> undoes a file's changes" },
		"merge": { "summary": "Not here yet.", "missing": "merging isn't here yet" },
		"rebase": { "summary": "Not here yet.", "missing": "rebasing isn't here yet" },
		"stash": { "summary": "Not here yet.", "missing": "stashing isn't here yet — commit, or restore what you don't want" },
		"reset": { "summary": "Not here.", "missing": "git restore --staged <path> unstages, git restore <path> undoes" },
		"show": { "summary": "Not here yet.", "missing": "show isn't here yet — git log lists the commits" },
		"push": { "summary": "Not here: the git is local.", "missing": "this workspace's git is local — the Commit button sends it to GitHub" },
		"pull": { "summary": "Not here: the git is local.", "missing": "this workspace's git is local — load the repository again for what's new" },
		"fetch": { "summary": "Not here: the git is local.", "missing": "this workspace's git is local — load the repository again for what's new" },
		"clone": { "summary": "Not here.", "missing": "load a repository from the Open button instead" },
		"remote": { "summary": "Not here: the git is local.", "missing": "this workspace's git is local, with no remotes" },
		"rm": { "summary": "Not here.", "missing": "delete the file (rm <path>), then git add it" },
		"mv": { "summary": "Not here.", "missing": "move the file (mv <from> <to>), then git add both" },
		"init": { "summary": "Not needed.", "missing": "this workspace is a repository already" }
	}
} satisfies CommandDefinition;
