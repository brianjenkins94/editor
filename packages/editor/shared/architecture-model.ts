/**
 * The DECLARED architecture of the editor — the reference the live architecture view checks what it observes
 * against (engine: pure data + functions, node-testable; the view and the probes are the bindings).
 *
 * - `containers`: where code runs (realms, origins), nested like the real thing (workbench iframe ⊃ ext host iframe
 *   ⊃ its worker).
 * - `nodes`: the contexts we expect, by id — hub ids for hub-carrying contexts, probe ids for the rest.
 * - `hubLinks`: the hub TREE. `subjects`: each subject family's direction — who sends it (publishes the event, makes
 *   the call) and who it's for (subscribes, serves) — and a family's messages may only cross the tree links on the path
 *   from a sender to a receiver, that way round (a reply, back). Adding a publisher or a subscriber is a change here.
 * - `channels`: the non-hub channels (workers, extension hosts, network, storage), each with the reason it isn't a hub
 *   link (`ChannelReason`) — a new direct channel has to say why it can't ride the hub.
 *
 * Webviews (`webview:<id>`, in the workbench iframe) are declared for what works here: a document set inline and VS Code's
 * webview messages — the insights Monitor, a Markdown preview. What doesn't: resources a webview loads by URL
 * (asWebviewUri), which VS Code serves through its own service worker by a per-webview subdomain a single-origin build
 * can't provide; ours load none.
 *
 * When the architecture changes, change this file with it: the view flags anything observed but not declared here.
 */

export interface ContainerSpec {
	"id": string;
	"label": string;
	"caption": string;
	"parent"?: string;
	/** Column of a top-level container (left → right follows the hub tree). */
	"column"?: number;
	"kind": "realm" | "origin" | "group" | "process";
	/** The node this box stands for: drawn as the box itself (its lines meet the box's header), not a box of its own. */
	"node"?: string;
	/** Collapsible, and whether it starts collapsed: collapsed, it's drawn as its header alone, and its nodes' lines meet
	 *  that header (click the header to open or close it). */
	"collapsed"?: boolean;
}

export interface NodeSpec {
	"id": string;
	"label": string;
	"container": string;
	"detail"?: string;
	"description": string;
	/** How it's observed — so a missing node points at the right probe. */
	"observedBy": string;
	/** Only exists in some situations. */
	"condition"?: string;
	/** It carries a @brianjenkins94/hub (its id is the hub id). */
	"hub"?: boolean;
	/** Whether a run reaches it at all, and which way, is the browser cache's and timing's (an icon's SVG): left out of
	 *  the tour's diagram, which has to be the same every run. */
	"cacheDependent"?: boolean;
}

/**
 * Why a channel isn't a hub link — every direct channel says, so adding one means saying why it can't ride the hub:
 * `platform` (a protocol the browser or VS Code owns), `shared memory` or `storage` (the data itself is the channel),
 * `synchronous` (it can't wait on the hub), `isolation` (it keeps an untrusted page off the hub), `bulk data` (a stream
 * too heavy for it), or `in-realm` (plain calls within one realm).
 */
export type ChannelReason = "platform" | "shared memory" | "storage" | "synchronous" | "isolation" | "bulk data" | "in-realm";

export interface ChannelSpec {
	/** Node id patterns (`*` = any run of characters). */
	"a": string;
	"b": string;
	"protocol": string;
	"transport": string;
	"reason": ChannelReason;
	"description": string;
}

/**
 * A subject family, with its direction: who sends it, and who it's for. An event goes `from` a publisher `to` its
 * subscribers; a call goes `from` its callers `to` the hub that serves it, and its reply comes back. Each is allowed only
 * along the hub tree's path from one of its senders to one of its receivers, in that direction — so adding a publisher
 * or a subscriber somewhere is a change to the model, and says who talks to whom. `*` = every hub.
 */
export interface SubjectFamily {
	/** NATS-style pattern on the subject (RPC by method name: `git.status` for `$rpc.call.git.status`). */
	"pattern": string;
	/** Who sends it: publishes the event, or makes the call. */
	"from": string[];
	/** Who it's for: subscribes to the event, or serves the call (and so sends the reply). */
	"to": string[];
}

export const containers: ContainerSpec[] = [
	{ "id": "shell", "label": "Shell", "caption": "top window · project picker, git review panel, previews", "column": 0, "kind": "realm" },
	{ "id": "app", "label": "App iframe", "caption": "/ · root of the hub tree, preview backend", "column": 1, "kind": "realm" },
	{ "id": "workbenchIframe", "label": "Workbench iframe", "caption": "/__vscode__/host.html · monaco-vscode-api", "column": 2, "kind": "origin" },
	{ "id": "workbench", "label": "Main thread", "caption": "workbench realm (shared with the LocalProcess extension host)", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "editorWorkers", "label": "Editor workers", "caption": "monaco's dedicated workers", "parent": "workbenchIframe", "kind": "realm", "collapsed": true },
	{ "id": "workers", "label": "App workers", "caption": "spawned by the workbench realm (and the node worker's child)", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "debugWorkers", "label": "Debug workers", "caption": "a debug worker per tsval session (spawned top-level from the LocalProcess host)", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "extHostIframe", "label": "Extension host iframe", "caption": "hidden iframe · relays its worker", "parent": "workbenchIframe", "kind": "origin" },
	{ "id": "extHostWorker", "label": "Web worker extension host", "caption": "LocalWebWorker extensions, tsserver", "parent": "extHostIframe", "kind": "realm" },
	{ "id": "browserChannels", "label": "Browser channels", "caption": "BroadcastChannels and Web Locks — shared by every tab and worker of the origin, past the hub", "column": 3, "kind": "group" },
	{ "id": "stores", "label": "Stores", "caption": "what the editor keeps — tools' files by shape — discovered from what's written and read", "column": 3, "kind": "group" },
	{ "id": "sharedMemory", "label": "Shared memory", "caption": "SharedArrayBuffer · Atomics locks", "column": 3, "kind": "group" },
	{ "id": "browser", "label": "Browser", "caption": "storage", "column": 3, "kind": "group" },
	{ "id": "network", "label": "Network (service worker)", "caption": "every HTTP request goes out through the service worker · debug-mcp's WebSocket connects directly", "column": 3, "kind": "group", "node": "sw" },
	{ "id": "peers", "label": "Peer connections", "caption": "WebRTC — straight to another browser, past the service worker", "column": 3, "kind": "group" }
];

export const nodes: NodeSpec[] = [
	{ "id": "shell", "label": "Shell", "container": "shell", "hub": true, "detail": "hub · shell.tsx", "description": "The top window: project picker, top bar, the git review panel and the preview windows. Signs in with GitHub (shell/session.ts): its DPoP key and the API's tokens, never a GitHub token.", "observedBy": "its hub reporter + network probes" },
	{ "id": "root", "label": "Root", "container": "app", "hub": true, "detail": "hub · main.tsx", "description": "The app iframe and the root of the hub tree: serves project.list / workbench.init, bridges the service worker and debug-mcp, hosts the log collector and the preview backend.", "observedBy": "its hub reporter + network probes" },
	{ "id": "sw", "label": "Service worker", "container": "network", "hub": true, "detail": "hub · sw.js", "description": "One per origin, shared by every tab: takes every HTTP request of the pages and workers it controls and makes the upstream one itself — stamping COOP/COEP, serving the CDN node_modules overlay and /__virtual__ previews, gating network access through capability.decide.", "observedBy": "its hub reporter + network probes" },
	{ "id": "webview-sw", "label": "Webview service worker", "container": "network", "detail": "VS Code's, per webview", "description": "VS Code serves a webview's resources through its own service worker, by a per-webview subdomain a single-origin build can't provide: a webview that asks for one (a Markdown preview's stylesheet) gets an error back. Ours load none.", "observedBy": "the webview probe (load-resource / did-load-resource)", "condition": "when a webview loads a resource by URL", "cacheDependent": true },
	{ "id": "workbench", "label": "Workbench", "container": "workbench", "hub": true, "detail": "hub · workbench-entry.tsx", "description": "The monaco-vscode-api boot: services, editors, the main side of every extension host, the git service, run targets.", "observedBy": "its hub reporter + the monaco probes + network probes" },
	{ "id": "exthost:LocalProcess:0", "label": "Local extension host", "container": "workbench", "detail": "the bridge, tsval", "description": "Extension host sharing the workbench realm: the bridge, the bridge — core's vscode API is its — and tsval, the stepping debugger, an extension of its own beside it (it spawns its debug workers top-level too).", "observedBy": "RPCProtocol logger on its ExtensionHostManager" },
	{ "id": "bridge", "label": "Bridge", "container": "workbench", "hub": true, "detail": "hub · the bridge extension", "description": "The bridge extension's hub (in the LocalProcess extension host): the debug workers link to it, and it serves capability.decide.", "observedBy": "its hub reporter" },
	{ "id": "debug-worker", "label": "Debug worker", "container": "debugWorkers", "hub": true, "detail": "hub · tsval stepping", "description": "One per tsval debug session, spawned by the bridge's debug adapter, which drives it by messages (the debug protocol). Its hub link is the workspace runtime's (editor-api's connectRuntime): a server its program starts answers the preview through it, and its log and spans are the editor's.", "observedBy": "its hub reporter + the Worker probe", "condition": "while debugging" },
	{ "id": "exthost-iframe", "label": "Iframe relay", "container": "extHostIframe", "detail": "webWorkerExtensionHostIframe.html", "description": "Boots the web worker extension host, relays its first messages and hands its MessagePort to the workbench.", "observedBy": "window message listener" },
	{ "id": "exthost:LocalWebWorker:0", "label": "Worker extension host", "container": "extHostWorker", "detail": "eslint, capabilities, default extensions", "description": "Extension host in a web worker: the default extensions (typescript-language-features and its tsserver), eslint and capabilities.", "observedBy": "RPCProtocol logger + an in-worker probe (its fetches and the workers it spawns)" },
	{ "id": "idb", "label": "IndexedDB", "container": "browser", "detail": "user data, logs, workspace-fs", "description": "monaco's user data / logs / storage, and the workspace filesystem snapshot.", "observedBy": "IDBObjectStore probe" },
	{ "id": "net:origin", "label": "Page origin", "container": "network", "detail": "app, node_modules overlay, ATA", "description": "The app's own server (dev server or Pages): bundles, the node_modules CDN overlay, type acquisition.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:unpkg.com", "label": "unpkg", "container": "network", "detail": "CDN node_modules", "description": "The service worker's upstream for the node_modules overlay.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:registry.npmjs.org", "label": "npm registry", "container": "network", "detail": "type acquisition", "description": "typescript-language-features' automatic type acquisition, from the worker extension host (package metadata for @types lookups); and the workbench's dependency resolver (workbench/versions.ts), each resolved version's own dependencies.", "observedBy": "the service worker's fetch probe", "condition": "when a file imports a package, or a project's dependencies change" },
	{ "id": "net:api.deps.dev", "label": "deps.dev", "container": "network", "detail": "dependency versions", "description": "The workbench's dependency resolver (workbench/versions.ts): every version of each dependency and when it was published, so nothing younger than a week is resolved into .silo/versions.json.", "observedBy": "the service worker's fetch probe", "condition": "when a project's dependencies change" },
	{ "id": "zenfs", "label": "Workspace (zen-fs)", "container": "sharedMemory", "detail": "SingleBuffer at /workspace", "description": "The workspace filesystem: a zen-fs SingleBuffer store in a SharedArrayBuffer the workbench creates and hands to the node worker (over the hub) and to each debug run's worker (in its launch), which mount it at /workspace. Same bytes in every realm, guarded by an Atomics lock. Shared memory notifies nobody, so each realm watches its own mount's writes and reports them as workspace.changed; the workbench persists every one to IndexedDB and announces it to VS Code, whoever wrote (the provider, isomorphic-git, the terminal, a node script).", "observedBy": "each realm's /workspace mount (zen-fs StoreFS operations), the provider's change events, the workspace-fs IndexedDB" },
	{ "id": "net:brianjenkins94.github.io", "label": "GitHub Pages", "container": "network", "detail": "preview packages", "description": "A previewed app's tarball dependencies (a URL in its package.json — e.g. @brianjenkins94/hub), fetched once by the node worker's dev server and served from /@pkg/.", "observedBy": "the service worker's fetch probe", "condition": "when a previewed app depends on a tarball" },
	{ "id": "net:esm.sh", "label": "esm.sh", "container": "network", "detail": "preview dependencies", "description": "The previewed app's bare imports (react, react-dom, react-refresh), mapped by the dev server's import map and fetched by the preview through the service worker.", "observedBy": "the service worker's fetch probe", "condition": "while a preview runs" },
	{ "id": "net:cdn.jsdelivr.net", "label": "jsDelivr", "container": "network", "detail": "preview DevTools", "description": "A preview's DevTools: chobitsu (the CDP implementation added to the previewed page) and Chrome's DevTools frontend (chii's build).", "observedBy": "the service worker's fetch probe", "condition": "while a preview's DevTools is open" },
	{ "id": "net:ka-f.fontawesome.com", "label": "Font Awesome", "container": "network", "detail": "WebAwesome icons", "description": "WebAwesome's default icon library: the shell chrome's wa-icon elements load their SVGs from the Font Awesome kit CDN, through the service worker.", "observedBy": "the service worker's fetch probe", "cacheDependent": true },
	{ "id": "net:open-vsx.org", "label": "Open VSX", "container": "network", "detail": "extension gallery", "description": "The extension gallery.", "observedBy": "the service worker's fetch probe", "condition": "when the gallery is queried" },
	{ "id": "net:api.github.com", "label": "GitHub API", "container": "network", "detail": "shell, signed out", "description": "Loading a public repo, from the signed-out shell, with no credential (signed in, GitHub is reached through the editor's API).", "observedBy": "the service worker's fetch probe", "condition": "when a public repo is loaded signed out" },
	{ "id": "net:cors.isomorphic-git.org", "label": "isomorphic-git's proxy", "container": "network", "detail": "shell, signed out", "description": "A signed-out public repo's clone: github.com's git endpoints send no CORS headers, so it goes through isomorphic-git's public proxy, with no credential.", "observedBy": "the service worker's fetch probe", "condition": "when a public repo is loaded signed out" },
	{ "id": "net:editor-api-dev.brianjenkins94.workers.dev", "label": "The editor's API (dev)", "container": "network", "detail": "shell, signed in", "description": "packages/api, on Cloudflare Workers: signing in with GitHub, our DPoP-bound tokens, and GitHub through its proxy (the API calls the editor makes, and a clone's git reads) with the token it keeps.", "observedBy": "the service worker's fetch probe", "condition": "when signing in, or signed in and loading or committing a repo" },
	{ "id": "net:api.unusuallygood.dev", "label": "The editor's API (production)", "container": "network", "detail": "shell, signed in, on editor.unusuallygood.dev", "description": "packages/api's production deployment, the API of the production site (session.ts picks it by host): signing in with GitHub, our DPoP-bound tokens, and GitHub through its proxy (the API calls the editor makes, and a clone's git reads) with the token it keeps.", "observedBy": "the service worker's fetch probe", "condition": "when signing in, or signed in and loading or committing a repo" },
	{ "id": "net:lighter.codehike.org", "label": "Code Hike", "container": "network", "detail": "diff highlighting", "description": "Syntax highlighting for the git review diffs.", "observedBy": "the service worker's fetch probe", "condition": "when a diff opens" },
	{ "id": "debug-mcp", "label": "debug-mcp", "container": "network", "hub": true, "detail": "hub · Node, ws://localhost:7378", "description": "The Node collector + MCP server: receives $sys.log, serves its own tools and every connected tab's page tools to an MCP client.", "observedBy": "root's topology (and its own reporter)", "condition": "npm run debug-mcp" }
];

export const hubLinks: [string, string][] = [
	["shell", "root"],
	["root", "workbench"],
	["root", "sw"],
	["root", "debug-mcp"],
	["workbench", "bridge"],
	["bridge", "debug-worker"]
];

export const subjects: SubjectFamily[] = [
	// ── observability ──
	{ "pattern": "$sys.log.>", "from": ["*"], "to": ["root", "debug-mcp", "shell"] },
	{ "pattern": "$sys.metrics.>", "from": ["*"], "to": ["bridge", "debug-mcp", "shell"] },
	{ "pattern": "$sys.backlog.log", "from": ["root"], "to": ["debug-mcp"] },
	// The architecture plane itself (observability's arch.ts): every context's reports, to the live view and debug-mcp, and
	// their ask for full state. Not observed — it's what observation rides — so declared for the source scan's sake.
	{ "pattern": "$sys.arch.sync", "from": ["workbench", "debug-mcp"], "to": ["*"] },
	{ "pattern": "$sys.arch.>", "from": ["*"], "to": ["workbench", "debug-mcp"] },
	{ "pattern": "tab.discover", "from": ["debug-mcp", "root"], "to": ["root"] },
	{ "pattern": "tab.here", "from": ["root"], "to": ["debug-mcp"] },
	{ "pattern": "page_tools.changed", "from": ["root", "shell"], "to": ["debug-mcp"] },
	{ "pattern": "page_tools.*", "from": ["debug-mcp"], "to": ["root"] },
	{ "pattern": "tool.>", "from": ["debug-mcp", "root"], "to": ["root"] },
	// ── the shell ⇄ the app and the workbench ──
	{ "pattern": "project.>", "from": ["shell"], "to": ["root"] },
	{ "pattern": "workbench.init", "from": ["workbench"], "to": ["root"] },
	{ "pattern": "workbench.online", "from": ["workbench"], "to": ["root"] },
	{ "pattern": "workbench.save", "from": ["workbench"], "to": ["root"] },
	{ "pattern": "architecture.violations", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "workbench.openProject", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "git.status", "from": ["shell", "bridge", "root"], "to": ["workbench"] },
	{ "pattern": "git.file", "from": ["shell", "bridge"], "to": ["workbench"] },
	{ "pattern": "git.commit", "from": ["shell", "bridge", "root"], "to": ["workbench"] },
	{ "pattern": "git.diff", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "git.discard", "from": ["shell", "root"], "to": ["workbench"] },
	{ "pattern": "git.review", "from": ["shell", "root"], "to": ["workbench"] },
	{ "pattern": "git.branch", "from": ["root", "shell"], "to": ["workbench"] },
	{ "pattern": "git.checkout", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "git.origin", "from": ["shell"], "to": ["workbench"] },
	{ "pattern": "git.unpushed", "from": ["shell"], "to": ["workbench"] },
	{ "pattern": "git.log", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "git.show", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "git.blame", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "git.pull", "from": ["root", "shell"], "to": ["workbench"] },
	{ "pattern": "git.push", "from": ["root", "shell", "workbench"], "to": ["workbench"] },
	{ "pattern": "git.remote", "from": ["workbench"], "to": ["shell"] },
	{ "pattern": "git.identity", "from": ["workbench"], "to": ["shell"] },
	{ "pattern": "github.actions", "from": ["workbench"], "to": ["shell"] },
	{ "pattern": "git.changed", "from": ["workbench"], "to": ["shell", "bridge"] },
	{ "pattern": "packages.tarball", "from": ["bridge"], "to": ["workbench"] },
	{ "pattern": "runs.list", "from": ["shell", "root", "bridge"], "to": ["workbench"] },
	{ "pattern": "runs.stop", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "runs.begin", "from": ["bridge"], "to": ["workbench"] },
	{ "pattern": "theme.colorScheme", "from": ["shell"], "to": ["workbench"] },
	{ "pattern": "theme.colors", "from": ["workbench"], "to": ["shell"] },
	// ── the workspace ──
	{ "pattern": "workspace.changed", "from": ["workbench"], "to": ["workbench"] },
	// ── running node ──
	{ "pattern": "node.out.*", "from": ["bridge"], "to": ["workbench"] },
	{ "pattern": "node.exit.*", "from": ["bridge", "workbench"], "to": ["workbench", "bridge"] },
	{ "pattern": "node.stdin.*", "from": ["workbench"], "to": ["bridge"] },
	{ "pattern": "node.listening.*", "from": ["bridge"], "to": ["workbench"] },
	// ── debugging ──
	{ "pattern": "debug.launch", "from": ["workbench"], "to": ["bridge"] },
	{ "pattern": "debug.stop", "from": ["workbench"], "to": ["bridge"] },
	{ "pattern": "debug.declined.*", "from": ["bridge"], "to": ["workbench"] },
	{ "pattern": "editor.state", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "editor.trace", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "problems.list", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "files.*", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "code.*", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "decisions.for", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "tests.*", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "notifications.list", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "terminal.state", "from": ["root"], "to": ["workbench"] },
	{ "pattern": "bridge.ready", "from": ["debug-worker"], "to": ["bridge"] },
	{ "pattern": "runtime.fs.attach", "from": ["debug-worker"], "to": ["bridge"] },
	// (a runtime link from the web worker extension host reaches the bridge through the workbench)
	{ "pattern": "bridge.ready", "from": ["workbench"], "to": ["workbench", "bridge"] },
	{ "pattern": "runtime.fs.attach", "from": ["workbench", "bridge"], "to": ["workbench", "bridge"] },
	// ── capabilities ──
	{ "pattern": "capability.prompt", "from": ["bridge"], "to": ["shell"] }
];

export const channels: ChannelSpec[] = [
	{ "a": "workbench", "b": "worker:*", "protocol": "WebWorker protocol / postMessage", "transport": "Worker.postMessage", "reason": "platform", "description": "monaco's editor workers (request/reply/events) and the workbench's own workers." },
	{ "a": "bridge", "b": "debug-worker", "protocol": "the debug protocol (ToWorker / WorkerEvent); the runtime's file calls (editor-api's mailbox)", "transport": "Worker.postMessage; SharedArrayBuffer + Atomics", "reason": "isolation", "description": "The adapter drives its run by messages of their own — launch, steps, decisions; values, stops, coverage back — not over the hub: the worker's hub link is only the workspace runtime's (editor-api), what any debugger's worker is given. And a debugger's worker reads and writes the workspace synchronously through its mailbox (handed over once, runtime.fs.attach): it writes a call and waits; the bridge answers it (runtime-fs.ts), the policy deciding the program's calls. tsval's reads its files from the workspace's buffer instead; another debugger's (editor-contrib's) has only the mailbox." },
	{ "a": "workbench", "b": "ext:*", "protocol": "the workspace runtime's hub link (editor-api's observeExtension)", "transport": "MessagePort (through the web worker host's probe port)", "reason": "isolation", "description": "Any extension in the web worker host on the observability plane — a contributed one too: its logs and metrics ride the hub as ext:<name>'s, and nothing of the editor's services crosses. The Margin's warnings, say." },
	{ "a": "bridge", "b": "ext:*", "protocol": "the workspace runtime's hub link (editor-api's observeExtension)", "transport": "MessagePort", "reason": "isolation", "description": "Any extension in the bridge's host on the observability plane, as in the web worker host's: its logs and metrics as ext:<name>'s." },
	{ "a": "workbench", "b": "exthost:LocalProcess:*", "protocol": "RPCProtocol", "transport": "in-memory buffers", "reason": "platform", "description": "MainThread / ExtHost proxies, serialized even in the same realm." },
	{ "a": "workbench", "b": "exthost-iframe", "protocol": "bootstrap handshake", "transport": "window.postMessage", "reason": "platform", "description": "NLS bootstrap, then the MessagePort handoff." },
	{ "a": "workbench", "b": "exthost:LocalWebWorker:*", "protocol": "RPCProtocol", "transport": "MessagePort (transferred ArrayBuffers)", "reason": "platform", "description": "MainThread / ExtHost proxies." },
	{ "a": "exthost:LocalWebWorker:*", "b": "ext:*/*", "protocol": "extension defined (LSP, tsserver)", "transport": "Worker.postMessage", "reason": "platform", "description": "Workers the web worker extension host's extensions spawn, each named by its extension (`ext:<extension>/<worker>`): TypeScript's servers, the event sheet's recognizer, the cspell language server." },
	{ "a": "exthost:LocalWebWorker:*", "b": "nested:*", "protocol": "worker defined", "transport": "Worker.postMessage", "reason": "platform", "description": "A worker the web worker extension host starts that no extension's code did." },
	// The service worker takes EVERY request from the pages and workers it controls (stamping cross-origin isolation,
	// answering its own routes, resolving node_modules from the CDN, gating a preview's data fetches) and makes the
	// upstream one itself — so each context's HTTP goes to `sw`, and only `sw` reaches the network. (WebSockets don't
	// pass through it: debug-mcp.)
	{ "a": "workbench", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "reason": "platform", "description": "The workbench bundle and its chunks, extension files, the node_modules overlay, type acquisition, the extension gallery." },
	{ "a": "worker:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "reason": "platform", "description": "Workers loading their assets (onig.wasm, models)." },
	{ "a": "exthost:LocalWebWorker:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "reason": "platform", "description": "Extensions loading their resources, and TypeScript's automatic type acquisition (npm package metadata)." },
	{ "a": "shell", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "reason": "platform", "description": "GitHub repos and publishing, diff highlighting, WebAwesome's icons." },
	{ "a": "sw", "b": "net:*", "protocol": "HTTP", "transport": "fetch", "reason": "platform", "description": "Every upstream request: the app's own server, the node_modules CDN, and the APIs the pages and workers call." },
	{ "a": "shell", "b": "net:*", "protocol": "HTTP", "transport": "fetch, before the service worker controls the page", "reason": "platform", "description": "A first visit on the dev server: the shell renders (its WebAwesome icons, …) before the newly registered service worker claims the page, so those requests go straight out. Once it's controlled, they go through the service worker." },
	{ "a": "workbench", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore", "reason": "storage", "description": "User data, logs, storage, workspace-fs." },
	{ "a": "shell", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore (editor-session)", "reason": "storage", "description": "The sign-in's DPoP key (shell/session.ts): a non-extractable CryptoKeyPair, made once and kept until sign-out — usable to sign the API's proofs, never readable as bytes." },
	{ "a": "webview-sw", "b": "webview:*", "protocol": "VS Code webview resources", "transport": "fetch, through VS Code's webview service worker", "reason": "platform", "description": "A webview's resources by URL (asWebviewUri) — answered with errors here (see webview-sw)." },
	{ "a": "workbench", "b": "webview:*", "protocol": "VS Code webview protocol", "transport": "window.postMessage", "reason": "platform", "description": "A webview's iframe — the insights Monitor, a Markdown preview: its document set inline, its messages VS Code's webview postMessage (an extension's postMessage/onDidReceiveMessage ride it)." },
	{ "a": "debug-worker", "b": "sw", "protocol": "HTTP", "transport": "fetch", "reason": "platform", "description": "A run's fetches the policy allows (RUNNING.md, *Effects are real, decided per call*: decided in the margin, made for real), like every controlled context's requests." },
	{ "a": "debug-worker", "b": "server:*", "protocol": "in-realm calls", "transport": "function calls", "reason": "in-realm", "description": "A debug run's own http.createServer, reached from a preview (the dev-server worker hands its port's requests over: virtual.debug.<port>)." },
	{ "a": "workbench", "b": "channel:vscode-web-state-db-global", "protocol": "VS Code storage sync", "transport": "BroadcastChannel", "reason": "platform", "description": "VS Code's global web storage (IndexedDB-backed) telling the editor's other tabs what changed." },
	{ "a": "workbench", "b": "channel:vscode-web-state-db-global-shared", "protocol": "VS Code storage sync", "transport": "BroadcastChannel", "reason": "platform", "description": "VS Code's shared global web storage, the same across tabs." },
	{ "a": "workbench", "b": "channel:vscode.indexedDB.vscode-userdata.changes", "protocol": "VS Code user-data sync", "transport": "BroadcastChannel", "reason": "platform", "description": "The user-data filesystem (settings, keybindings, snippets) announcing its changes to the editor's other tabs." },
	// the workspace filesystem (shared memory)
	{ "a": "workbench", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (owner)", "reason": "shared memory", "description": "The vscode provider (editor, tsserver, ATA, terminal, extensions) and direct callers (isomorphic-git, the terminal's path walk). Back the other way: provider writes announced as file-change events (5ms batches) — writes from other realms, and direct writes, are NOT announced." },
	{ "a": "zenfs", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore (workspace-fs, silo-local)", "reason": "storage", "description": "Provider writes, flushed every 500ms and restored at boot (workspace-fs); and silo's local/, a mount of its own store (silo-local)." }
];

// ── lookups ───────────────────────────────────────────────────────────────────────────────────────────────────

export function nodeSpec(id: string): NodeSpec | undefined {
	return nodes.find((node) => node.id === id);
}

function globMatches(pattern: string, id: string): boolean {
	if (!pattern.includes("*")) {
		return pattern === id;
	}

	const escaped = pattern.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*");

	return new RegExp("^" + escaped + "$", "u").test(id);
}

/** NATS semantics: `*` one token, `>` the rest. */
export function subjectMatches(pattern: string, subject: string): boolean {
	const patternTokens = pattern.split(".");
	const subjectTokens = subject.split(".");

	for (let index = 0; index < patternTokens.length; index += 1) {
		const token = patternTokens[index];

		if (token === ">") {
			return subjectTokens.length > index;
		}

		if (index >= subjectTokens.length || (token !== "*" && token !== subjectTokens[index])) {
			return false;
		}
	}

	return patternTokens.length === subjectTokens.length;
}

/** A hub link joins `first` and `second` — themselves, or the dynamic ids they're one of (`shell` ⇄ `preview:5173` is
 *  `preview:*`'s). */
function isHubLink(first: string, second: string): boolean {
	const [x, y] = [hubOf(first) ?? first, hubOf(second) ?? second];

	return hubLinks.some(([one, other]) => (one === x && other === y) || (one === y && other === x));
}

export function findChannel(first: string, second: string): ChannelSpec | undefined {
	return channels.find((channel) => (globMatches(channel.a, first) && globMatches(channel.b, second)) || (globMatches(channel.a, second) && globMatches(channel.b, first)));
}

/** The declared kind of a pair: a hub link, a declared channel, or nothing. */
export function declaredBetween(first: string, second: string): { "type": "hub" } | { "type": "channel"; "spec": ChannelSpec } | { "type": "discovered"; "kind": "commands" | "store" } | undefined {
	if (isHubLink(first, second)) {
		return { "type": "hub" };
	}

	// Discovered rather than declared (ARCHITECTURE.md, *Discovered, not declared*): between extensions is VS Code's command surface, and a
	// store is what's written to it and read from it.
	if (isExtensionNode(first) && isExtensionNode(second)) {
		return { "type": "discovered", "kind": "commands" };
	}

	if (isStoreNode(first) || isStoreNode(second)) {
		return { "type": "discovered", "kind": "store" };
	}

	const spec = findChannel(first, second);

	return spec === undefined ? undefined : { "type": "channel", "spec": spec };
}

/** Hubs on the tree path between two hubs (inclusive), or undefined if not both in the tree. */
function treePath(from: string, to: string): string[] | undefined {
	const previous = new Map<string, string | null>([[from, null]]);
	const queue = [from];

	while (queue.length > 0) {
		const current = queue.shift();

		if (current === to) {
			const path = [to];
			let step = previous.get(to);

			while (step !== null && step !== undefined) {
				path.unshift(step);
				step = previous.get(step);
			}

			return path;
		}

		for (const [x, y] of hubLinks) {
			let next: string | undefined;

			if (x === current) {
				next = y;
			} else if (y === current) {
				next = x;
			}

			if (next !== undefined && !previous.has(next)) {
				previous.set(next, current);
				queue.push(next);
			}
		}
	}

	return undefined;
}

const hubIds = [...new Set(hubLinks.flat())];

/** The hub an observed id is in the tree as: itself, or the dynamic id it's one of (`preview:5173` → `preview:*`). */
function hubOf(id: string): string | undefined {
	return hubIds.find((hub) => hub === id) ?? hubIds.find((hub) => hub.includes("*") && globMatches(hub, id));
}

/** What a hub traffic label is: a call (`git.status()`), its reply (`↩ git.status()`), or an event. */
export type MessageKind = "call" | "reply" | "event";

export function kindOfLabel(label: string): MessageKind {
	if (label.startsWith("↩ ")) {
		return "reply";
	}

	return label.endsWith("()") ? "call" : "event";
}

const expand = (ids: string[]): string[] => (ids.includes("*") ? hubIds : ids);

/**
 * Whether `family` lets a message of `kind` cross the hub link from `first` to `second`: it lies on the tree path from
 * one of the family's senders to one of its receivers, in that direction. An event or a call goes `from` → `to`; a
 * reply, back.
 */
export function familyAllowsHop(family: SubjectFamily, kind: MessageKind, first: string, second: string): boolean {
	const [x, y] = [hubOf(first), hubOf(second)];

	if (x === undefined || y === undefined) {
		return false;
	}

	const senders = expand(kind === "reply" ? family.to : family.from);
	const receivers = expand(kind === "reply" ? family.from : family.to);

	for (const sender of senders) {
		for (const receiver of receivers) {
			const path = sender === receiver ? [] : treePath(sender, receiver) ?? [];

			if (path.some((hub, index) => hub === x && path[index + 1] === y)) {
				return true;
			}
		}
	}

	return false;
}

/** The subject families that cross the hub link `first`–`second` at all, either way: the families the link carries. */
export function familiesOnLink(first: string, second: string): SubjectFamily[] {
	return subjects.filter((family) => (["event", "call"] as const).some((kind) => familyAllowsHop(family, kind, first, second) || familyAllowsHop(family, kind, second, first)));
}

/** Whether the model lets `label` (a hub message) cross from `first` to `second`. */
export function allowedOnLink(label: string, first: string, second: string): boolean {
	const subject = subjectOfLabel(label);

	return subject === undefined || subjects.some((family) => subjectMatches(family.pattern, subject) && familyAllowsHop(family, kindOfLabel(label), first, second));
}

/** The subject a hub traffic label stands for (`↩ git.status()` → `git.status`), or undefined for control frames. */
export function subjectOfLabel(label: string): string | undefined {
	if (label === "hello" || label.startsWith("interest (")) {
		return undefined;
	}

	return label.replace(/^↩ /u, "").replace(/\(\)$/u, "");
}

// ── conformance ───────────────────────────────────────────────────────────────────────────────────────────────

export type Violation =
	| { "type": "undeclared-channel"; "a": string; "b": string }
	/** A hub message crossed from `a` to `b`, which no family's senders and receivers send that way. */
	| { "type": "unexpected-subject"; "a": string; "b": string; "subject": string; "count": number }
	| { "type": "duplicate-peer"; "hub": string; "peer": string; "links": number }
	| { "type": "unknown-node"; "id": string };

/** `hub`: how many of a label's messages rode the hub — only those are subjects; the rest came from probes. `forward`
 *  and `backward`: how many went a → b and b → a (without them, a label is checked either way). */
export interface ObservedChannel { "a": string; "b": string; "labels": Map<string, { "count": number; "hub"?: number; "forward"?: number; "backward"?: number }>; "medium"?: string }

/** What the model says of an observed channel: of the pair it joins — or, for a pair meeting through a medium only they
 *  use (observability draws that as one edge, `medium`), of either end's channel to the medium: the model declares a
 *  BroadcastChannel as a node each end talks to. */
export function declaredOn(channel: { "a": string; "b": string; "medium"?: string }): ReturnType<typeof declaredBetween> {
	return channel.medium === undefined ? declaredBetween(channel.a, channel.b) : declaredBetween(channel.a, channel.medium) ?? declaredBetween(channel.b, channel.medium);
}

export interface ObservedTopology { "links": { "peerId"?: string }[] }

/** How many observed pairs each declared channel covers. A channel declared on a hub-linked pair (raw messages beside
 *  the hub link, on the same worker) is seen only through probe traffic — the hub's own belongs to the link. */
export function seenChannels(observed: ObservedChannel[]): Map<ChannelSpec, number> {
	const seen = new Map<ChannelSpec, number>();

	for (const channel of observed) {
		const spec = channel.medium === undefined ? findChannel(channel.a, channel.b) : findChannel(channel.a, channel.medium) ?? findChannel(channel.b, channel.medium);
		const probed = !isHubLink(channel.a, channel.b) || [...channel.labels.values()].some((label) => label.count > (label.hub ?? 0));

		if (spec !== undefined && probed) {
			seen.set(spec, (seen.get(spec) ?? 0) + 1);
		}
	}

	return seen;
}

/** Contexts created at runtime, by id prefix, and where they live. */
export const DYNAMIC_PREFIXES = ["nested:", "worker:", "server:", "channel:", "lock:", "rtc:", "webview:", "ext:", "store:"];

/** The hub messages on `channel`, a hub link, that no family sends the way they went: into `violations`. */
function checkSubjects(channel: ObservedChannel, violations: Violation[]): void {
	for (const [label, stats] of channel.labels) {
		const subject = (stats.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;
		const directed = stats.forward !== undefined || stats.backward !== undefined;

		if (subject !== undefined && !directed) {
			if (!allowedOnLink(label, channel.a, channel.b) && !allowedOnLink(label, channel.b, channel.a)) {
				violations.push({ "type": "unexpected-subject", "a": channel.a, "b": channel.b, "subject": subject, "count": stats.count });
			}
		} else if (subject !== undefined) {
			for (const [from, to, count] of [[channel.a, channel.b, stats.forward ?? 0], [channel.b, channel.a, stats.backward ?? 0]] as const) {
				if (count > 0 && !allowedOnLink(label, from, to)) {
					violations.push({ "type": "unexpected-subject", "a": from, "b": to, "subject": subject, "count": count });
				}
			}
		}
	}
}

/** Compare what's observed with the model. */
export function checkConformance(observed: { "nodes": string[]; "channels": ObservedChannel[]; "topology": Map<string, ObservedTopology> }): Violation[] {
	const violations: Violation[] = [];
	for (const channel of observed.channels) {
		const declared = declaredOn(channel);

		if (declared === undefined) {
			violations.push({ "type": "undeclared-channel", "a": channel.a, "b": channel.b });
		} else if (declared.type === "hub") {
			checkSubjects(channel, violations);
		}
	}

	for (const [hub, snapshot] of observed.topology) {
		const peers = new Map<string, number>();

		for (const link of snapshot.links) {
			if (link.peerId !== undefined) {
				peers.set(link.peerId, (peers.get(link.peerId) ?? 0) + 1);
			}
		}

		for (const [peer, links] of peers) {
			if (links > 1) {
				violations.push({ "type": "duplicate-peer", "hub": hub, "peer": peer, "links": links });
			}
		}
	}

	for (const id of observed.nodes) {
		const dynamic = DYNAMIC_PREFIXES.some((prefix) => id.startsWith(prefix));

		if (!dynamic && nodeSpec(id) === undefined) {
			violations.push({ "type": "unknown-node", "id": id });
		}
	}

	return violations;
}

/** Where a reporting hub runs (observability's ArchRealm). */
export interface ObservedRealm { "kind": "window" | "worker"; "url": string; "parent"?: string }

// ── probes' view of the model ─────────────────────────────────────────────────────────────────────────────────

/** An extension, discovered by its commands (extensions/command-tap.ts): `ext:<name>`, or `ext:vscode` for VS Code's own
 *  commands and its built-in extensions'. Not a worker an extension started: `ext:<name>/<worker>`. */
export function isExtensionNode(id: string): boolean {
	return id.startsWith("ext:") && !id.includes("/");
}

/**
 * A hub's components, discovered (ARCHITECTURE.md, *Discovered, not declared*): its subscriptions grouped by the function that registered
 * them (the hub's `sites`), or — where no name survived the build — by their subject's namespace. A call reads as
 * `name()`; an RPC client's own reply channel is machinery, not a component's.
 */
export function componentsOf(hub: { "subscriptions": string[]; "sites"?: Record<string, string[]> }): { "component": string; "subjects": string[] }[] {
	const components = new Map<string, Set<string>>();

	for (const pattern of hub.subscriptions) {
		const subscription = subscriptionOf(hub, pattern);

		if (subscription !== undefined) {
			const known = components.get(subscription.component) ?? new Set<string>();

			known.add(subscription.subject);
			components.set(subscription.component, known);
		}
	}

	return [...components].map(([component, subjects]) => ({ "component": component, "subjects": [...subjects].sort() })).sort((left, right) => left.component.localeCompare(right.component));
}

/** One subscription as a component's: the subject it reads as (a call as `name()`, a session's or port's own token as
 *  `*`) and its component — or none, for an RPC client's reply channel (machinery). */
function subscriptionOf(hub: { "sites"?: Record<string, string[]> }, pattern: string): { "subject": string; "component": string } | undefined {
	if (pattern.startsWith("$rpc.reply.")) {
		return undefined;
	}

	// A session's, a port's, a tab's own subject (`production.stop.<uuid>`, `preview.hmr.5173`) is one of a kind: `*`.
	// (An id with a word in front — an explore's `explore-<uuid>` — is one of a kind too.)
	const general = pattern.split(".").map((token) => (/^(?:\d+|(?:[a-z]+-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})$/u.test(token) ? "*" : token)).join(".");
	const subject = general.startsWith("$rpc.call.") ? general.slice("$rpc.call.".length) + "()" : general;

	return { "subject": subject, "component": hub.sites?.[pattern]?.[0] ?? subject.split(".")[0] };
}

/** The component of `hub` that handles `subject` (a label's: `annotations.resolve` for a call or its reply) — the one
 *  subscribed to it, as `componentsOf` names it — or undefined where the hub only relays it. */
export function componentFor(hub: { "subscriptions": string[]; "sites"?: Record<string, string[]> }, subject: string): string | undefined {
	for (const pattern of hub.subscriptions) {
		const method = pattern.startsWith("$rpc.call.") ? pattern.slice("$rpc.call.".length) : pattern;

		// Either way round: a label's own subject may be folded already (`virtual.request.*`, a tab's own).
		if (!pattern.startsWith("$rpc.reply.") && (subjectMatches(method, subject) || subjectMatches(subject, method))) {
			return subscriptionOf(hub, pattern)?.component;
		}
	}

	return undefined;
}

/** A store, discovered by what's written and read in it (architecture-zenfs.ts, storeShape): `store:<shape>`. */
export function isStoreNode(id: string): boolean {
	return id.startsWith("store:");
}

/** What the editor keeps, discovered: each store — a tool's files by shape, or an IndexedDB database — with who wrote it
 *  and who read it, from what was observed (ARCHITECTURE.md, *Discovered, not declared*). */
export function discoveredStores(observed: { "channels": { "a": string; "b": string; "labels": Map<string, unknown> | Record<string, unknown> }[] }): { "store": string; "writers": string[]; "readers": string[] }[] {
	const stores = new Map<string, { "writers": Set<string>; "readers": Set<string> }>();
	const touch = (store: string, by: string, operation: string): void => {
		const known = stores.get(store) ?? { "writers": new Set(), "readers": new Set() };
		const writes = /\b(?:write|create|put|add|delete|unlink|mkdir|rename|clear|touch)\b/u.test(operation);

		(writes ? known.writers : known.readers).add(by);
		stores.set(store, known);
	};

	for (const channel of observed.channels) {
		const labels = channel.labels instanceof Map ? [...channel.labels.keys()] : Object.keys(channel.labels);

		for (const [store, by] of [[channel.b, channel.a], [channel.a, channel.b]] as const) {
			if (isStoreNode(store)) {
				for (const label of labels) {
					touch(store.slice("store:".length), by, label);
				}
			} else if (store === "idb") {
				// `<database> › <object store>.<operation>`, by its owner (idbOwner) or the realm that opened it.
				for (const label of labels) {
					const [database, rest] = label.split(" › ");

					if (rest !== undefined) {
						touch(`IndexedDB ${database}`, by, rest);
					}
				}
			}
		}
	}

	return [...stores].map(([store, { writers, readers }]) => ({ "store": store, "writers": [...writers].sort(), "readers": [...readers].sort() })).sort((left, right) => left.store.localeCompare(right.store));
}

export function dynamicContainer(id: string): string | undefined {
	if (id.startsWith("webview:")) {
		return "workbenchIframe";
	}

	if (id.startsWith("server:") || id.startsWith("worker:")) {
		return "workers";
	}

	// A realm's channels past its hub (observability's network probes): a BroadcastChannel or a Web Lock, shared within
	// the origin; a peer connection, to another browser.
	if (id.startsWith("channel:") || id.startsWith("lock:")) {
		return "browserChannels";
	}

	if (id.startsWith("store:")) {
		return "stores";
	}

	if (id.startsWith("rtc:")) {
		return "peers";
	}

	return undefined;
}

/** What a tour observed: its shards' sessions' (the view's snapshots), together (test/architecture-diagram.mjs). */
export interface TourSnapshot {
	"nodes": { "id": string; "state": string; "spec"?: { "label"?: string; "container"?: string } }[];
	"channels": { "a": string; "b": string; "medium"?: string; "labels": Record<string, { "count": number }> }[];
	"topology": Record<string, { "subscriptions": string[] }>;
}

/** An instance's id, as one of a kind: a port, a webview, a numbered server is the same part each run. */
function generalId(id: string, label: string | undefined): string {
	return id.replace(/^server:\d+$/u, "server:*").replace(/^webview:.*$/u, `webview:${label ?? "*"}`).replace(/ #\d+$/u, "");
}

/** Does a store operation change the store? (A tool's file: storeShape's operations; a database: IndexedDB's.) */
function writesStore(operation: string): boolean {
	return /\b(?:write|create|put|add|delete|unlink|mkdir|rename|clear|touch)\b/u.test(operation);
}

/**
 * ARCHITECTURE.md's diagram, rendered from what a tour observed (ARCHITECTURE.md, *Discovered, not declared*) — nothing declared but where
 * things run (the containers): every context, extension and store seen, and what joined them, as a Mermaid flowchart; then
 * the stores, with who writes and who reads each; then each hub's components by namespace (the registering functions'
 * names don't survive a minified build, and the diagram has to be the same from either). Instances read as one of a kind
 * (`server:<port>`), no counts: the same tour renders the same diagram, so a change to it is a change to the editor.
 */
export function tourDiagram(snapshot: TourSnapshot): string {
	// A page's own requests before the service worker controls it (a first visit's: `shell ⇄ net:*`) aren't the editor's
	// architecture, and whether a run makes them depends on the browser's cache: left out, and a host only they reached.
	const firstVisit = (channel: { "a": string; "b": string }): boolean => [channel.a, channel.b].some((end) => end.startsWith("net:")) && channel.a !== "sw" && channel.b !== "sw";
	const channels = snapshot.channels.filter((channel) => !firstVisit(channel));
	const reached = new Set(channels.flatMap((channel) => [channel.a, channel.b]));
	const seen = new Map(snapshot.nodes.filter((node) => node.state !== "declared" && nodeSpec(node.id)?.cacheDependent !== true && (!node.id.startsWith("net:") || reached.has(node.id))).map((node) => [node.id, node]));
	const general = (id: string): string => generalId(id, seen.get(id)?.spec?.label);
	const label = (id: string): string => (seen.get(id)?.spec?.label ?? nodeSpec(id)?.label ?? id).replace(/^store:/u, "").replace(/:\d{4,5}\b/u, ":*").replace(/ #\d+$/u, "").replace(/ \(\d+\)$/u, "");
	// Mermaid reads `<` and `"` as its own.
	const text = (value: string): string => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "'");
	const mermaidId = (id: string): string => "n_" + id.replaceAll(/\W/gu, "_");
	const known = new Set(containers.map((container) => container.id));
	const containerOf = (id: string): string | undefined => {
		const declared = seen.get(id)?.spec?.container ?? nodeSpec(id)?.container;

		return declared !== undefined && known.has(declared) ? declared : dynamicContainer(id);
	};

	// The parts, one of a kind each, in their containers.
	const parts = new Map<string, string>();

	for (const id of seen.keys()) {
		parts.set(general(id), id);
	}

	const partsIn = (container: string | undefined, indent: string): string[] => [...parts].filter(([, id]) => containerOf(id) === container).map(([part, id]) => `${indent}${mermaidId(part)}["${text(label(id))}"]`).sort();
	// A container with nothing seen in it is left out.
	const box = (container: ContainerSpec, indent: string): string[] => {
		const inside = [...partsIn(container.id, indent + "  "), ...containers.filter((child) => child.parent === container.id).flatMap((child) => box(child, indent + "  "))];

		return inside.length === 0 ? [] : [`${indent}subgraph c_${container.id}["${container.label}"]`, ...inside, `${indent}end`];
	};

	const lines = ["flowchart LR", ...containers.filter((container) => container.parent === undefined).flatMap((container) => box(container, "  ")), ...partsIn(undefined, "  ")];

	// What joined them: a hub link, a declared channel's protocol, an extension's commands, a store's reads and writes.
	const edges = new Set<string>();

	for (const channel of channels.filter((candidate) => seen.has(candidate.a) && seen.has(candidate.b))) {
		const declared = declaredOn(channel);
		const operations = Object.keys(channel.labels);
		// Either way round, the same edge (but a store's, from who touched it).
		const [one, other] = [general(channel.a), general(channel.b)].sort();

		if (declared?.type === "hub") {
			edges.add(`  ${mermaidId(one)} <==> ${mermaidId(other)}`);
		} else if (declared?.type === "discovered" && declared.kind === "store") {
			const [store, by] = isStoreNode(one) ? [one, other] : [other, one];
			const how = [operations.some((operation) => !writesStore(operation)) && "reads", operations.some(writesStore) && "writes"].filter(Boolean).join(", ");

			edges.add(`  ${mermaidId(by)} -->|"${how}"| ${mermaidId(store)}`);
		} else {
			let how = "undeclared";

			if (declared?.type === "discovered") {
				how = "commands";
			} else if (declared !== undefined) {
				how = declared.spec.protocol;
			}

			edges.add(`  ${mermaidId(one)} <-.->|"${text(how + (channel.medium === undefined ? "" : " via " + channel.medium))}"| ${mermaidId(other)}`);
		}
	}

	lines.push(...[...edges].sort());

	const names = (ids: string[]): string => [...new Set(ids.filter((id) => seen.has(id)).map((id) => label(id)))].sort().join(", ") || "—";
	// A database named for its workspace (`vscode-web-state-db-<hash>`) is one of a kind too.
	const stores = new Map(discoveredStores(snapshot).map((store) => [store.store.replace(/-[0-9a-f]{8}$/u, "-*"), store]));
	// A hub's components, past the observability plane every hub has (`$sys`) — the editor's standing hubs only: declared,
	// unconditional, and still running when the tour ends. One that comes and goes (a preview, a debug run's worker) is
	// running at the end, or not, as its environment's timing has it.
	const components = new Map<string, string>();
	const standing = (hub: string): boolean => seen.get(hub)?.state === "alive" && !DYNAMIC_PREFIXES.some((prefix) => hub.startsWith(prefix)) && nodeSpec(hub) !== undefined && nodeSpec(hub)?.condition === undefined;

	for (const [hub, topology] of Object.entries(snapshot.topology).filter(([candidate]) => standing(candidate))) {
		for (const { component, subjects } of componentsOf({ "subscriptions": topology.subscriptions.filter((subject) => !subject.startsWith("$sys.")) })) {
			components.set(`${label(hub)}\0${component}`, `| ${label(hub)} | ${component} | ${subjects.map((subject) => `\`${subject}\``).join(", ")} |`);
		}
	}

	return [
		"```mermaid",
		...lines,
		"```",
		"",
		"| Store | Written by | Read by |",
		"| --- | --- | --- |",
		...[...stores].sort(([left], [right]) => left.localeCompare(right)).map(([name, store]) => `| \`${name}\` | ${names(store.writers)} | ${names(store.readers)} |`),
		"",
		"| Hub | Component | Serves and hears |",
		"| --- | --- | --- |",
		...[...components].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row)
	].join("\n");
}
