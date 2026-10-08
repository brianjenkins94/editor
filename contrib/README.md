# editor-contrib

A starting point for plugging an **interpreter** and a **code renderer** into
[brianjenkins94/editor](https://github.com/brianjenkins94/editor). It's an ordinary VS Code web extension, so what it
uses is public VS Code API.

> This repository is generated from [`contrib/`](https://github.com/brianjenkins94/editor/tree/main/contrib) in the
> editor and updated each time the editor builds, tests and deploys successfully. Change it there, not here. To start
> your own, use **Use this template**.

## The interpreter — `src/interpreter.ts`

A debug adapter (the Debug Adapter Protocol, inline in the extension). The editor runs every file as a debug session,
so breakpoints, stepping, the Variables view and the Debug Console come with the protocol. What the editor draws over
the code comes from the custom events in `src/contract.ts`:

| Event | What the editor does with it | Status |
| --- | --- | --- |
| `coverage` | marks the lines that ran, and how often | read today |
| `values` | shows values in the margin beside their code | the editor reads it from tsval only, for now |

Positions are in the text that ran: 0-based lines and `[start, end)` offsets. The editor maps offsets to its BABLR span
ids, so what you report follows its code through edits.

## The renderer — `src/renderer.ts`

A custom text editor: **Reopen Editor With… → Rendered (contrib)**. The file's text stays the truth — render from it
and write changes back as `WorkspaceEdit`s, and the editor's history, annotations and live runs keep working.

## Build

```bash
npm install
npm run build
```

CI runs the editor's own workflow for contributions (`.github/workflows/ci.yml`), so what a contribution is checked
against moves with the editor.
