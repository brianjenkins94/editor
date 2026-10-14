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

## Node's built-ins: unenv, and ours where we must differ

Since 2026-10-14 the built-in modules are [unenv](https://github.com/unjs/unenv)'s (pinned `2.0.0-rc.24`; what esm.sh
and Cloudflare's Node compatibility build on), assembled in `builtins.ts`, three ways:

- **unenv's as they are**: events, buffer, assert, path, os, querystring, url, punycode, constants, timers, tty,
  readline, v8, dgram, cluster, diagnostics_channel, inspector, trace_events, repl, worker_threads, util/types — their
  shims here are deleted, and almostnode's own code (the http/net bridge, process, streams) extends unenv's EventEmitter.
- **unenv's with a few names of ours over them**, where a program here needs them to work and unenv's only say "not
  implemented": dns (lookups answering localhost — Vite resolves `localhost` as it starts), util (callbackify,
  stripVTControlCharacters), perf_hooks (PerformanceObserver), domain (Domain, create). Those shims hold only those names.
- **ours, unenv filling in what they lack**: what the editor is behind (http/https/http2/net/tls — the dev servers'
  bridge; child_process's ENOSYS; fs over the VFS; module's `createRequire`; each runtime's process), what we implement
  and unenv stubs (crypto's hashes, zlib, stream, string_decoder, vm), and async_hooks and console. A runtime's fs and
  process get unenv's missing names too.

unenv's modules import each other by Node's names (`node:events`); `unenv-resolve.ts` makes those unenv's own — a
bundler of almostnode uses its `unenvResolve()` plugin (the editor's build does), the tests their loader.
`test/builtins.test.ts` holds each built-in to a floor of Node's names it really has (present, not a stub), so a change
that loses some fails.

## Remaining dependencies

`unenv` (and its one dependency, `pathe`), `resolve.exports`, `pako`, `typescript`. `css-tree` and `just-bash`
(which itself pulled quickjs) were pruned — see below. `brotli-wasm` is a lazy, `@vite-ignore`d import in
`shims/zlib.ts` that the editor never reaches (it uses the gzip path via `pako`).

## Local edits vs. upstream

- `create-runtime.ts` — trimmed to the main-thread `createRuntime`; worker/sandbox branches removed.
- `index.ts` — reduced barrel exporting only the consumed surface.
- `runtime.ts` — `createDynamicImport` routes a `file://` dynamic import (e.g. eslint's flat-config loader)
  to a NATIVE `import()` of the real same-origin path, handing it to the service-worker module resolver
  (serves the workspace at `/workspace/…`) instead of re-executing it through almostnode's require/VFS path.
  This replaced the `packages/editor/patch-almostnode.mjs` `file://`→VFS stopgap (now deleted).
- `shims/zlib.ts` — the `brotli-wasm` dynamic import is `@vite-ignore`d.
- `frameworks/esm-cjs.ts` — `transformEsmToCjsSimple` (the only thing `runtime.ts` used from the old
  `frameworks/code-transforms.ts`) split out so the csstree-backed CSS-modules helper is no longer in the
  graph. `code-transforms.ts` deleted → **`css-tree` dropped**. Since 2026-10-14 it is TypeScript's own CommonJS
  emit (`transpileModule`), not the hand-written transform: imports are live (a cycle sees a binding once it's
  set), exported declarations keep their local names, exports follow later assignments, and a module's own
  `require` (`createRequire`) is renamed so its imports still go through the loader's.
- Node fidelity, found running real ESLint with a full preset (2026-10-14; each in `test/modules.test.ts`):
  top-level `await` (the body runs async; `import()` waits for it, `require()` throws ERR_REQUIRE_ASYNC_MODULE);
  `require()` of a folder reads its package.json `main`, `require(".")`/`("..")`, a package whose entry is
  `index.json`; a package with `main` and `module` is required as its `main` (`module` only stands in with no
  `main`); built-in subpaths `assert/strict` (a real strict variant), `stream/promises`;
  `process.getBuiltinModule`; `import.meta.resolve`; `path.toNamespacedPath`; `util.isDeepStrictEqual`; assert's
  legacy `equal`/`notEqual`/`deepEqual`/`notDeepEqual`.
- `shims/child_process.ts` — replaced with an ENOSYS stub (spawning is unavailable in-browser; sync ops throw,
  async report via callback/`error`, `initChildProcess` is a no-op). `shims/vfs-adapter.ts` and
  `shims/child_process-browser.ts` deleted → **`just-bash` (and quickjs) dropped**. The editor's language
  servers run via `runFile` and never spawn; verified in the running editor that eslint + typescript + cspell
  still lint correctly with this stub.
