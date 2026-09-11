# almostnode (vendored)

A vendored, trimmed copy of [macaly/almostnode](https://github.com/macaly/almostnode)@0.2.14 (MIT).

## Why vendor

Upstream hadn't shipped in ~7 months and its published package drags in a large surface the editor never
uses — `@ai-sdk/*`, `ai`, `zod`, `@xterm/*`, `comlink`, `brotli-wasm`, and demo/dev-server/agent-workbench
code. The editor uses exactly one path: the same-origin, main-thread `Runtime` (via `createRuntime`) to run
bundled node language servers (cspell, eslint) inside a worker. Vendoring lets us keep only that path and
prune the dependency tree.

## What's kept vs. dropped

Kept: `runtime.ts`, `create-runtime.ts` (main-thread only), `virtual-fs.ts`, `runtime-interface.ts`,
`server-bridge.ts`, `frameworks/esm-cjs.ts`, and the `shims/`, `utils/`, `types/`, `config/` trees.

Dropped from upstream: `worker-runtime.ts` / `sandbox-runtime.ts` (and `comlink`), `worker/`, all demos,
`dev-server.ts`, framework adapters, `frameworks/code-transforms.ts` (and `css-tree`), `npm/` PackageManager,
`sandbox-helpers.ts`, `transform.ts`, `agent-workbench-*`, the vite/next plugins, and their deps. The
`child_process` shim is stubbed (dropping `just-bash`/quickjs); `shims/vfs-adapter.ts` deleted with it.

## Remaining dependencies

Just three, all on the core runtime path: `acorn`, `resolve.exports`, `pako`. `css-tree` and `just-bash`
(which itself pulled quickjs) were pruned — see below. `brotli-wasm` is a lazy, `@vite-ignore`d import in
`shims/zlib.ts` that the editor never reaches (it uses the gzip path via `pako`).

## Local edits vs. upstream

- `create-runtime.ts` — trimmed to the main-thread `createRuntime`; worker/sandbox branches removed.
- `index.ts` — reduced barrel exporting only the consumed surface.
- `runtime.ts` — `createDynamicImport` routes a `file://` dynamic import (e.g. eslint's flat-config loader)
  to a NATIVE `import()` of the real same-origin path, handing it to the service-worker module resolver
  (serves the workspace at `/workspace/…`) instead of re-executing it through almostnode's require/VFS path.
  This replaced the `packages/vscode/patch-almostnode.mjs` `file://`→VFS stopgap (now deleted).
- `shims/zlib.ts` — the `brotli-wasm` dynamic import is `@vite-ignore`d.
- `frameworks/esm-cjs.ts` — `transformEsmToCjsSimple` (the only thing `runtime.ts` used from the old
  `frameworks/code-transforms.ts`) split out so the csstree-backed CSS-modules helper is no longer in the
  graph. `code-transforms.ts` deleted → **`css-tree` dropped**.
- `shims/child_process.ts` — replaced with an ENOSYS stub (spawning is unavailable in-browser; sync ops throw,
  async report via callback/`error`, `initChildProcess` is a no-op). `shims/vfs-adapter.ts` and
  `shims/child_process-browser.ts` deleted → **`just-bash` (and quickjs) dropped**. The editor's language
  servers run via `runFile` and never spawn; verified in the running editor that eslint + typescript + cspell
  still lint correctly with this stub.
