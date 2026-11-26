/**
 * What the agent's tool use says about the tools (the user, 2026-11-02 and 2026-11-26): where it went around the editor
 * though a tool of the editor's does that (a bypass), where it ran something often that no tool does (a candidate for
 * one), where it stood in for a tool with page_eval (a workaround), where a tool kept failing (friction), and where an
 * answer was more than it could read (oversize). From the counts alone (agent.ts `usage`): each a finding to act on,
 * by giving a tool, fixing one, or using the one there is.
 */
import type { ToolUse, ToolUses } from "./agent.ts";

export interface Finding {
	"kind": "bypass" | "candidate" | "workaround" | "friction" | "oversize";
	"tool": string;
	/** How many calls it's about. */
	"count": number;
	"said": string;
	/** The editor's tool that does it, for a bypass. */
	"instead"?: string;
}

/** Claude Code's own tools, and the editor's that do what they do. */
const AROUND: Record<string, string> = {
	"Read": "files_read",
	"Write": "files_write",
	"Edit": "files_edit",
	"MultiEdit": "files_edit",
	"Glob": "files_glob",
	"Grep": "files_grep"
};

/** A command's program, and the editor's tools that do what it's usually run for. */
const PROGRAMS: Record<string, string> = {
	"git": "git_status, git_diff, git_log, git_show, git_commit, git_push…",
	"grep": "files_grep",
	"rg": "files_grep",
	"egrep": "files_grep",
	"cat": "files_read",
	"head": "files_read",
	"tail": "files_read",
	"sed": "files_read, files_edit or files_replace",
	"ls": "files_glob",
	"find": "files_glob",
	"rm": "files_delete",
	"mv": "code_move",
	"eslint": "code_problems or editor_problems",
	"tsc": "code_problems or editor_problems",
	"node": "runs_tests or script_run",
	"npx": "runs_tests or script_run",
	"npm": "runs_tests or script_run"
};

/** Programs that aren't work an editor tool could take: the shell's own plumbing. */
const PLUMBING = new Set(["echo", "printf", "pwd", "true", "false", "test", "[", "sleep", "wc", "sort", "uniq", "tr", "cut", "tee", "xargs", "awk", "jq", "date", "which", "kill", "pkill", "for", "while", "if", "do", "done", "then", "fi"]);

const BYPASS_AT = 3;
const CANDIDATE_AT = 5;
const FRICTION_AT = { "failures": 3, "share": 0.2 };
const OVERSIZE_AT = 50_000;
const WORKAROUNDS = new Set(["page_eval", "page_query"]);

const times = (count: number): string => `${String(count)} ${count === 1 ? "time" : "times"}`;

/** The findings in `uses`, the most calls first. */
export function auditUse(uses: ToolUse[]): Finding[] {
	const findings: Finding[] = [];

	for (const use of uses) {
		const linked = use.linked ?? 0;

		if (use.via === "around" && AROUND[use.tool] !== undefined && linked >= BYPASS_AT) {
			findings.push({ "kind": "bypass", "tool": use.tool, "count": linked, "instead": AROUND[use.tool], "said": `${use.tool} ${times(linked)} while an editor was linked: ${AROUND[use.tool]} does it there` });
		}

		for (const [program, count] of Object.entries(use.programs ?? {})) {
			if (PROGRAMS[program] !== undefined && count >= BYPASS_AT) {
				findings.push({ "kind": "bypass", "tool": `${use.tool} ${program}`, "count": count, "instead": PROGRAMS[program], "said": `${program} in the shell ${times(count)} while an editor was linked: ${PROGRAMS[program]}` });
			} else if (PROGRAMS[program] === undefined && !PLUMBING.has(program) && count >= CANDIDATE_AT) {
				findings.push({ "kind": "candidate", "tool": `${use.tool} ${program}`, "count": count, "said": `${program} in the shell ${times(count)} while an editor was linked, and no editor tool does what it's run for: one to write (its UI first), or a reason it stays in the shell` });
			}
		}

		if (WORKAROUNDS.has(use.tool) && use.calls >= BYPASS_AT) {
			findings.push({ "kind": "workaround", "tool": use.tool, "count": use.calls, "said": `${use.tool} ${times(use.calls)}: what was it standing in for? Its calls are spans (spans_query, source agent)` });
		}

		if (use.failures >= FRICTION_AT.failures && use.failures / use.calls >= FRICTION_AT.share) {
			findings.push({ "kind": "friction", "tool": use.tool, "count": use.failures, "said": `${use.tool} failed ${String(use.failures)} of ${String(use.calls)} times` });
		}

		if (use.largest >= OVERSIZE_AT) {
			findings.push({ "kind": "oversize", "tool": use.tool, "count": use.calls, "said": `${use.tool} answered with ${String(Math.round(use.largest / 1000))} KB once: more than it's read whole` });
		}
	}

	return findings.toSorted((one, other) => other.count - one.count);
}

/** Each tool's use and what it says, as the editor's Features and Tests shows it and agent_usage answers it. */
export const withFindings = (usage: ToolUses): ToolUses & { "findings": Finding[] } => ({ ...usage, "findings": auditUse(usage.tools) });
