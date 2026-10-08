# editor-contrib

A starting point for plugging an **interpreter** and a **code renderer** into
[brianjenkins94/editor](https://github.com/brianjenkins94/editor). It's an ordinary VS Code web extension, so what it
uses is public VS Code API.

## Try it

1. Fork this repository, and set **Settings → Pages → Source** to **GitHub Actions**. Every push to `main` builds,
   tests and publishes the extension to `https://<you>.github.io/editor-contrib/`.
2. Open the editor with `?extension=https://<you>.github.io/editor-contrib/`.
3. Set `"run.debugger": "contrib"` in the editor's settings, and press Run (▷) on a file.

While working on it, serve it from your machine instead — on `localhost` itself (the editor's extension host takes
http only from `localhost` or `127.0.0.1`):

```bash
npm install && npm run build && npx http-server . -p 5190 --cors -c-1
```

and open the editor with `?extension=http://localhost:5190/`.

## The interpreter — `src/interpreter.ts`

A debug adapter (the Debug Adapter Protocol, inline in the extension). The editor runs every file as a debug session,
so breakpoints, stepping, the Variables view and the Debug Console come with the protocol. What the editor draws over
the code comes from the custom events in `src/contract.ts`:

| Event | What the editor does with it |
| --- | --- |
| `values` | shows each value in the margin beside its code |
| `coverage` | marks the lines that ran, and keeps it as the run's evidence |

Positions are in the text that ran: 0-based lines and `[start, end)` offsets. The editor maps offsets to its BABLR span
ids, so what you report follows its code through edits. Each run is listed in the editor's Running view.

## The editor's BABLR

The editor parses code with BABLR (its TypeScript grammar), and keeps every text's parse cached. An extension can ask
for a text's spans — the CST nodes an annotation can attach to:

```ts
const spans = await vscode.commands.executeCommand("editor.annotations.spans", source);
// [{ id, start, end }, …] — or undefined when the grammar doesn't take the text
```

Each `id` is the node's Merkle hash (its type over its tokens' text and its children's hashes, whitespace and comments
left out), so it survives the node moving and changes when the node does. `editor.annotations.refer` and
`editor.annotations.resolve` keep something attached to a span across edits.

## The renderer — `src/renderer.ts`

A custom text editor: **Reopen Editor With… → Rendered (contrib)**. The file's text stays the truth — render from it
and write changes back as `WorkspaceEdit`s, and the editor's history, annotations and live runs keep working.

## Where this comes from

This repository is kept up to date from [`contrib/`](https://github.com/brianjenkins94/editor/tree/main/contrib) in
the editor, whose tests run it in the editor on every change: each change made there arrives here as a commit, applied
as a patch, so what this repository changes of its own stays.
