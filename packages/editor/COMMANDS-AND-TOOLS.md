# Commands and tools

The editor has two surfaces that people and agents type into: the terminal's commands (just-bash plus our own), and the
MCP tools an agent calls (debug-mcp's own, and the ones a tab serves). Both grew one addition at a time. This is how
each should be organized so that adding to it is one folder, and what people will expect from each that isn't there.

## One rule for both

**If it's text in and text out, it's a terminal command. If it needs structure or the editor's state, it's a tool.**

An agent already reaches every terminal command through the `shell` tool, so a terminal command is automatically
an agent capability; a tool that wraps a command is a duplicate. Tools are for what a command line can't give:
unsaved buffers, the debugger at a stop, the Problems view, a preview's DOM, JSON an agent will act on.

**One folder per thing, named after it, holding everything about it**: its definition, its implementation, its test,
and its help. A registry finds the folders (`import.meta.glob`), so adding one touches nothing else. Every list that
enumerates commands or tools today (tab completion, the streaming regex, the `shell` tool's description, docs) is
derived from the registry instead of kept by hand. `silo features` recognizes both definitions, so the inventory and
the derived history (CHANGE-HISTORY.md) track them for free.

## The terminal

### Today

just-bash 3.4.2 ships 80-odd commands: the coreutils people expect (ls, cat, grep, rg, sed, awk, find, sort, uniq, wc,
head, tail, cut, tr, xargs, diff, tree, jq, base64, sha256sum, gzip, date, sleep, which, env, clear, help…), with pipes,
redirects, functions and `--help` on each. Ours are three: `node` (a debugger run), `npm` (install writes package.json;
run/start/test), `vite` (a preview).

Adding a command means touching five places: a `terminal-<x>.ts`, the import list and the `customCommands` array in
terminal.ts, the hand-kept `COMMANDS` completion list (which offers `more`, which doesn't exist), and the `STREAMING`
regex in terminal-session.ts if it streams; plus the `shell` tool's description and docs that list commands.

### The layout (built: step 1)

```
packages/editor/terminal/
  index.ts            the terminal process: prompt, line editor, OSC 633, sessions; loads each command on first use
  session.ts          statement splitting, the $PWD probe
  fs.ts               just-bash's file system over the workspace
  integration.ts      VS Code's shell integration (OSC 633)
  catalog.ts          finds the commands (import.meta.glob of commands/*/command.ts) and derives everything from them
  commands/
    node/   command.ts  node.ts
    npm/    command.ts  npm.ts
    vite/   command.ts  vite.ts
    git/    command.ts  git.ts  git.test.mjs        (next)
```

A folder's `command.ts` says what the command is, in a few lines that import nothing, so anything can read the catalog
without loading a command:

```ts
export default {
	"name": "node",                 // the folder's name too; a mismatch is an error at load
	"summary": "Run a program in the debugger, its output and input here.",
	"streaming": true               // writes live to the terminal, so a line with it runs a statement at a time
} satisfies CommandDefinition;
```

`<name>.ts` exports `create(host)`, which returns the just-bash command. The host is the same for every command: the
workspace API, the node runner, live output to this terminal, the terminal's number, and the shell itself (for
`npm run`). just-bash loads it the first time the command runs.

Derived from the catalog: Tab completion (the shell's builtins, just-bash's own `getCommandNames()` as this build has
them, and ours), which commands stream, and the `shell` tool's description. just-bash's `help` lists only builtins, so
listing our commands with their summaries is still to do (step 2).

### What people will expect, by how soon they'll be annoyed

**In the first minute**: these get typed out of habit, and failing is the first impression.

| Command | Today | What it should do |
|---|---|---|
| `git status`, `diff`, `log`, `add`, `commit`, `restore`, `branch`, `checkout` | missing | isomorphic-git, already loaded for Source Control (git-service.ts); the same engine, as a command |
| `node -e "…"`, `node --test`, `node` alone | broken | `-e` runs the string; `--test` runs node:test files under the debugger; bare `node` says there's no REPL yet |
| `npm ci`, `npm ls`, `npm exec`, `npx <bin>` | missing | ci = install; ls reads package.json; exec/npx run a package's bin where we can (`npx tsc`, `npx eslint`) and say so where we can't |
| `code <file>`, `open <file>` | missing | open it in the editor (and `code .` reveals the folder) |
| `history` | prints nothing | the terminal's own history, which lives in terminal.ts |
| `ps`, `kill <id>` | missing | the runs registry: what's running (node, vite, tasks) and stopping one |
| `more`, `less` | completion offers `more`; neither exists | page through output in the terminal, or just print it |
| `ln -s` | ENOSYS | symlinks in the workspace fs, or a plain error saying they aren't supported |

**Within the first hour**:

| Command | What it should do |
|---|---|
| `tsc`, `tsc --noEmit` | the TypeScript server's diagnostics, printed like tsc does (they're what Problems shows) |
| `eslint` | the in-browser eslint engine over the given files |
| `silo features`, `silo history` | silo's command line on the workspace: util/silo's internals over isomorphic-git snapshots |
| `curl`, `wget` | just-bash's `network` option, gated by the capability rules like any other fetch |
| `man <cmd>` | `<cmd> --help` (our commands need `--help` too; today node, npm and vite don't answer it) |
| `date` | local time, not UTC: pass the browser's time zone as `TZ` |

**Never, but say so**: python, vim, nano, ssh, make, docker, deno, bun, tar, sqlite3. A command-not-found for these
reads as "broken". A registry entry with no implementation, only a sentence, reads as "known, and here's what to do
instead":

```
$ vim app.ts
vim isn't available here — the file is open in the editor (code app.ts).
```

Each of those is a folder too (`commands/vim/command.ts` with a `missing` message), so the list of what we don't
provide is as visible and as easy to change as what we do.

## The MCP tools

### Today

Three sources, two schemas:

- **debug-mcp's own** (8, zod, `packages/debug-mcp/src/mcp.ts`): `query_logs`, `query_spans`, `get_tree_state`,
  `get_architecture`, `query_metrics`, `capture_payloads`, `wait_for`, `list_tabs`.
- **Every page's built-ins** (2, JSON Schema, observability): `page_eval`, `page_query`.
- **The editor tab's** (25, JSON Schema, `packages/editor/page-tools.ts`), each a thin call to a hub RPC served in some
  other module: `debug_*` (6), `files_*` (5), `shell`, `git`, `margin`, `editor`, `problems`, `notifications`,
  `terminal`, `previews`, `rules`, `runs`, `run_ledger`, `preview_cdp`, `preview_profile`, `provoke_transform`.

Adding an editor tool means touching four or five places: the backend `serve(...)` in its owning module, wiring in
workbench-entry.tsx, the entry in page-tools.ts, the subject in architecture-model.ts, and a test (page-tools.test.mjs
covers only the debug tools and `preview_cdp`).

What's wrong with it beyond the effort:

- **Names follow three styles**: verb-first (`query_logs`, `list_tabs`), family-first (`files_read`, `debug_step`),
  and bare nouns (`margin`, `editor`, `terminal`, `runs`), which don't say what they act on or what they do.
  `terminal` reads like it runs commands; it only reads output.
- **One action per tool, except when not**: `debug_*` is six tools; `git` and `runs` hide their actions in an argument.
- **A preview is addressed three ways**: `tab`, `frame` (a substring), and `port`/`window`.
- **`tab` means two things** in debug-mcp: a filter (omitted = all tabs) for the query tools, a target (omitted = the
  editor tab, failing if there are several) for the others.
- **Overlap**: `shell` against `files_*` (only `files_*` see unsaved buffers); `runs` against `debug_sessions`;
  `previews` against `list_tabs`; `margin` against `debug_state`; `preview_cdp` against `page_eval`.

### The layout

The tool and the backend it calls live together, in a folder named after the family. They still run in different
realms (the tool in the tab's root hub, the backend in the workbench or worker-pod), so the folder holds both files and
each realm imports its own:

```
packages/editor/tools/
  tools.ts                the registry: import.meta.glob("./*/tools.ts"); main.tsx serves what it finds
  files/   tools.ts  serve.ts  files.test.mjs     files_read · files_write · files_edit · files_glob · files_grep
  debug/   tools.ts  …                            debug_start · debug_step · debug_state · debug_stop · …
  editor/  tools.ts  serve.ts                     editor_state · editor_problems · editor_notifications · editor_open
  terminal/ tools.ts                              terminal_run (today's shell) · terminal_output (today's terminal)
  git/     tools.ts                               git_status · git_diff · git_log · git_commit
  runs/    tools.ts                               runs_list · runs_stop · runs_ledger
  previews/ tools.ts                              previews_list · previews_cdp · previews_profile
  margin/ · rules/ · code/ · silo/ …
packages/debug-mcp/src/tools/
  logs.ts  spans.ts  tabs.ts  architecture.ts  metrics.ts  …   one file per family, registered from a list
```

### The naming rule

`<family>_<verb>`, where the family is the folder: `files_read`, `git_status`, `runs_stop`, `editor_problems`,
`logs_query`, `tabs_list`. One action per tool; a tool that would take an `action` argument becomes one tool per action.
An agent can then read the tool list as a table of contents, and the family prefix says where it lives.

Renaming is a breaking change for anything that calls tools by name: this repo's tests and docs, debug-mcp's reserved
names, and agents' habits and notes. Doing it once, all together, behind a protocol bump (`OBSERVABILITY_PROTOCOL`),
costs less than living with three styles.

### Addressing, once

- **`tab`**: which page serves the tool; omitted means the editor tab. For debug-mcp's query tools, rename the filter
  to `from`, so `tab` always means one thing.
- **`window`**: which preview inside the editor tab (the id `previews_list` returns). It replaces `frame` substrings on
  `page_eval`/`page_query` and `port` on the `previews_*` tools.

### What agents will expect that isn't there

| Tool | Why |
|---|---|
| `code_definition`, `code_references`, `code_hover`, `code_symbols` | Agents navigate by symbol. The TypeScript server answers all four (VS Code's `execute…Provider` commands); today an agent greps. |
| `editor_open` | Show the user a file at a line, the way a person would point. |
| `debug_explore` | `debug.explore` is served "for an agent" but no tool reaches it. |
| `tests_run` | Run node:test files and get structured results, not terminal text. |
| `silo_features`, `silo_history` | The inventory and the derived history, as data. |

## Order

1. **The terminal layout and registry**, moving node, npm and vite into folders with no change in behavior; the
   derived completion list, streaming set and `shell` description.
2. **First-minute commands**: git, node's flags, npm's other verbs, code/open, history, ps/kill, the pager, and the
   "never, but say so" entries.
3. **The tools layout and registry**, moving today's tools into family folders with no change in behavior.
4. **The renaming and addressing**, all together, with the protocol bump.
5. **First-hour commands and the missing tools.**

## Open questions

- **Rename debug-mcp's own tools too?** They're the most used by agents (and in this project's notes), so renaming
  them costs the most; leaving them makes the rule have exceptions.
- **Folder names when a command's name is a JS keyword or clashes** (a `test` command, `node`): the folder is the
  command's name; files inside avoid the clash.
- **Desktop parity.** On desktop VS Code the terminal is real and has all of these. Our commands should behave like
  the real ones closely enough that muscle memory transfers, and the "never" list says where they can't.
