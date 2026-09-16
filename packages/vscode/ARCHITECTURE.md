# editor — architecture & "where does this code go?"

The editor spans ~six runtime **realms** (separate JS execution contexts). Most "where should this live?"
confusion is really "which realm does it need to run in?" — so this doc is the realm map plus a placement
procedure. For the capability-overlay subsystem specifically, read `extensions/capabilities/ARCHITECTURE.md`
after this; this doc is the whole-editor picture.

## The two axes behind every placement decision

1. **Which realm?** — decided by *what the code needs to touch* (DOM? the vscode API? the workspace filesystem?
   tsserver's Program? heavy CPU?). Placement follows the CAPABILITY the code needs, not the feature it belongs to.
2. **Engine or binding?** — a pure, reusable **engine** (fewest host deps, node-testable) kept separate from a thin
   **binding** that maps it into one realm. This axis cuts across every realm.

## The realms

| Realm | Entry / key files | Can access | What lives here |
|---|---|---|---|
| **Shell** (top window) | `main.tsx` `renderShell()` branch, `shell.ts` | DOM, the shell hub; *later* the GitHub token (trust boundary) | Surrounding chrome (LHS project picker, RHS history, top bar), cross-project coordination. Loads the app in an iframe pointing back at the same page. |
| **App iframe** (`/`) | `main.tsx` app branch, `coi.ts`, `vscode.tsx`, `samples.ts` | DOM, `rootHub`, COI bootstrap, the pane-bus host | Boots the workbench iframe (+ preview iframe); serves `project.list`, routes `project.open` → `openProject`. Owns the top of the hub tree. |
| **Workbench iframe** (`/__vscode__/host.html`) | `workbench-entry.tsx`, `workspace-fs.ts`, `git-scm.ts`, `git-engine.ts`, `ata.ts`, `terminal.ts`, `node-runner.ts` | **the vscode API *and* zen-fs** (both live here), DOM | Monaco/VS Code itself, and anything needing the editor API together with the workspace filesystem: git SCM, type acquisition, the terminal factory, the debug preview. Spawns the workers below. |
| **Extension host** (`LocalProcess` / `LocalWebWorker`) | `extensions/*/extension.ts`, `extensions/*/ts-plugin.js` | the vscode API — **no DOM, no zen-fs singleton** | Extensions: `hello` (default API context), `worker-pod` (spawns the LSP/debug/node workers). `eslint` + `capabilities` run in the WebWorker host *inside tsserver*, reusing tsserver's own `ts` as TS-plugins. |
| **Workers** (`dist/lsp/*`, spawned from the workbench realm) | only what is messaged in | nothing host-y | Heavy/blocking compute, off the UI thread: `node-worker` (almostnode/preview), `debug-worker` (tsval stepping), `server-host`, `git-classify-worker` (BABLR classify). |
| **Packages** (`packages/*`, plain node) | nothing host-y — pure | — | Engines: `@brianjenkins94/bablr` (`cstSpans`, `classifyChange`), `tsval`, `util/silo`, and the vscode-package-local pure modules `policy-core`, `capability-breakpoints`. Built/aliased into the realms above. |

There is also a **service worker** (`coi-serviceworker.js`, registered by `coi.ts`): one per origin, it stamps the
COOP/COEP headers that make every realm cross-origin-isolated (SharedArrayBuffer) on a static host, and resolves the
CDN `node_modules` overlay. Not a place you put feature code.

## Cross-realm communication

- **hub** (`@brianjenkins94/hub`) — the composed message tree for everything: pub/sub + RPC (`createRpcClient` /
  `serve`). Shape today: shell ↔ app over `windowTransport`; app `rootHub` ↔ workbench hub over a transferred
  `MessagePort`; workbench ↔ extension pod over the pod's exported event/function bridge; pod ↔ its workers over
  `portTransport`. A message only crosses a link if the far side subscribed, so each realm runs standalone.
- **pane-bus** (`pane-bus.ts`) — the app ↔ workbench boot handshake specifically (`ready` → `init` → `online`,
  plus `save` and `openProject`). Separate from the hub because it predates it and tracks the pane's live window
  (so it survives a pop-out).
- **plain postMessage** — fine for a single-purpose worker with one request/response shape (e.g. `git-classify-worker`).

## Placement procedure

Ask, in order:

1. **Pure logic, no host deps?** → a **package / engine module** (node-testable). *e.g. `classifyChange`, `git-engine`
   (no vscode dep), `policy-core`, `capability-breakpoints`.*
2. **Needs the vscode API *and* the workspace filesystem?** → the **workbench realm** (`workbench-entry` installs it,
   using the captured `vscodeApi` + zen-fs). *e.g. `git-scm`, type acquisition, the terminal factory.*
3. **Needs tsserver's Program / to run during type-checking?** → a **TS-plugin in the WebWorker ext host**, reusing
   tsserver's `ts`. *e.g. `capabilities`, `eslint`.*
4. **Heavy or blocking** (parse, interpret, run node)? → a **worker**, spawned from the workbench realm, async.
   *e.g. `git-classify-worker` — BABLR is ~1.7s/file, it cannot run on the UI thread.*
5. **Chrome / layout / cross-project / token custody?** → the **shell**.

Then apply **Axis 2**: split the part with the fewest host deps into an **engine** and leave a thin **binding** in
the realm. If you can't node-test the logic, you probably haven't separated the engine yet.

## Worked examples (the git/SCM + BABLR stack)

The cosmetic-diff feature spans four realms, each piece placed by the procedure:

- `classifyChange` / `cstSpans` — **package** (`@brianjenkins94/bablr`): pure, node-tested (rule 1).
- `git-engine.ts` — **workbench realm engine**: no vscode dep, but uses zen-fs, so it runs where zen-fs is; the
  reusable core of the two-tier history's coarse (git) tier (rule 1 within the realm).
- `git-scm.ts` — **workbench binding**: maps `git-engine` ↔ `vscode.scm` (rule 2). Swap this for a custom shell UI
  later; the engine is untouched.
- `git-classify-worker.ts` — **worker**: BABLR classification off-thread (rule 4). It sits at the top level next to
  the other git files — **not** under `extensions/worker-pod/`: worker-pod is the *LSP pod*, and this is a git
  concern. (Placement follows the *concern*; the realm follows the *capability*.)

The capability overlay is the same shape one layer over: pure core (`policy-core`, `capability-breakpoints`) → a
tsserver plugin (ext host) that emits diagnostics → an ext-host binding (`extensions/capabilities/extension.ts`)
that renders the panel. See `extensions/capabilities/ARCHITECTURE.md`.

## The one gotcha the realms impose

Cross-origin isolation (SharedArrayBuffer) must hold in **every** nested realm. The shell → app → workbench nesting
is all same-origin, and the service worker (prod) or dev headers stamp COOP/COEP, so isolation propagates — but a
new realm (another iframe, a worker) inherits it only under those same conditions. When adding a realm, confirm
`crossOriginIsolated` there before relying on SAB/Atomics.
