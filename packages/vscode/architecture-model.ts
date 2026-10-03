/**
 * The DECLARED architecture of the editor — the reference the live architecture view checks what it observes
 * against (engine: pure data + functions, node-testable; the view and the probes are the bindings).
 *
 * - `containers`: where code runs (realms, origins), nested like the real thing (workbench iframe ⊃ ext host iframe
 *   ⊃ its worker).
 * - `nodes`: the contexts we expect, by id — hub ids for hub-carrying contexts, probe ids for the rest.
 * - `hubLinks`: the hub TREE. `subjects`: which hubs publish/serve/subscribe each subject family — a family may only
 *   cross the tree links between its participants.
 * - `channels`: the non-hub channels (workers, extension hosts, network, storage).
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
}

export interface ChannelSpec {
	/** Node id patterns (`*` = any run of characters). */
	"a": string;
	"b": string;
	"protocol": string;
	"transport": string;
	"description": string;
}

export interface SubjectFamily {
	/** NATS-style pattern on the subject (RPC by method name: `git.status` for `$rpc.call.git.status`). */
	"pattern": string;
	/** Hubs that publish, serve or subscribe it. `*` = every hub. */
	"hubs": string[];
	"description": string;
}

export const containers: ContainerSpec[] = [
	{ "id": "shell", "label": "Shell", "caption": "top window · project picker, git review panel, previews", "column": 0, "kind": "realm" },
	{ "id": "app", "label": "App iframe", "caption": "/ · root of the hub tree, preview backend", "column": 1, "kind": "realm" },
	{ "id": "workbenchIframe", "label": "Workbench iframe", "caption": "/__vscode__/host.html · monaco-vscode-api", "column": 2, "kind": "origin" },
	{ "id": "workbench", "label": "Main thread", "caption": "workbench realm (shared with the LocalProcess extension host)", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "editorWorkers", "label": "Editor workers", "caption": "monaco's dedicated workers", "parent": "workbenchIframe", "kind": "realm", "collapsed": true },
	{ "id": "workers", "label": "App workers", "caption": "spawned by the workbench realm (and the node worker's child)", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "podWorkers", "label": "Pod workers", "caption": "the worker-pod extension's: its language servers, and a debug worker per tsval session", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "extHostIframe", "label": "Extension host iframe", "caption": "hidden iframe · relays its worker", "parent": "workbenchIframe", "kind": "origin" },
	{ "id": "extHostWorker", "label": "Web worker extension host", "caption": "LocalWebWorker extensions, tsserver", "parent": "extHostIframe", "kind": "realm" },
	{ "id": "previews", "label": "Preview windows", "caption": "iframes in the shell, any number per server (preview:<port>, preview:<port>~<n>) · served from /__virtual__/<tab>/<port>/ by the service worker", "parent": "shell", "kind": "origin" },
	{ "id": "previewApp", "label": "App", "caption": "the previewed app's own hubs, workers and frames, per window (joined through the shell, named <window>/<hub>) · its architecture, not the editor's", "parent": "previews", "kind": "group" },
	{ "id": "sharedMemory", "label": "Shared memory", "caption": "SharedArrayBuffer · Atomics locks", "column": 3, "kind": "group" },
	{ "id": "browser", "label": "Browser", "caption": "storage", "column": 3, "kind": "group" },
	{ "id": "network", "label": "Network (service worker)", "caption": "every HTTP request goes out through the service worker · debug-mcp's WebSocket connects directly", "column": 3, "kind": "group", "node": "sw" },
	{ "id": "browserChannels", "label": "Browser channels", "caption": "BroadcastChannels and Web Locks — shared by every tab and worker of the origin, past the hub", "column": 3, "kind": "group" },
	{ "id": "peers", "label": "Peer connections", "caption": "WebRTC — straight to another browser, past the service worker", "column": 3, "kind": "group" }
];

export const nodes: NodeSpec[] = [
	{ "id": "shell", "label": "Shell", "container": "shell", "hub": true, "detail": "hub · shell.tsx", "description": "The top window: project picker, top bar, the git review panel and the preview windows. Holds the GitHub token.", "observedBy": "its hub reporter + network probes" },
	{ "id": "root", "label": "Root", "container": "app", "hub": true, "detail": "hub · main.tsx", "description": "The app iframe and the root of the hub tree: serves project.list / workbench.init, bridges the service worker and debug-mcp, hosts the log collector and the preview backend.", "observedBy": "its hub reporter + network probes" },
	{ "id": "sw", "label": "Service worker", "container": "network", "hub": true, "detail": "hub · sw.js", "description": "One per origin, shared by every tab: takes every HTTP request of the pages and workers it controls and makes the upstream one itself — stamping COOP/COEP, serving the CDN node_modules overlay and /__virtual__ previews, gating network access through capability.decide.", "observedBy": "its hub reporter + network probes" },
	{ "id": "webview-sw", "label": "Webview service worker", "container": "network", "detail": "VS Code's, per webview", "description": "VS Code serves a webview's resources through its own service worker, by a per-webview subdomain a single-origin build can't provide: a webview that asks for one (a Markdown preview's stylesheet) gets an error back. Ours load none.", "observedBy": "the webview probe (load-resource / did-load-resource)", "condition": "when a webview loads a resource by URL" },
	{ "id": "workbench", "label": "Workbench", "container": "workbench", "hub": true, "detail": "hub · workbench-entry.tsx", "description": "The monaco-vscode-api boot: services, editors, the main side of every extension host, the git service, run targets.", "observedBy": "its hub reporter + the monaco probes + network probes" },
	{ "id": "exthost:LocalProcess:0", "label": "Local extension host", "container": "workbench", "detail": "hello, worker-pod", "description": "Extension host sharing the workbench realm: the hello extension (the captured vscode API) and worker-pod.", "observedBy": "RPCProtocol logger on its ExtensionHostManager" },
	{ "id": "pod", "label": "Pod", "container": "workbench", "hub": true, "detail": "hub · worker-pod extension", "description": "The worker-pod extension's hub (in the LocalProcess extension host): spawns the LSP and debug workers, serves capability.decide.", "observedBy": "its hub reporter" },
	{ "id": "node", "label": "Dev-server worker", "container": "workers", "hub": true, "detail": "hub · almostnode, preview dev servers", "description": "Hosts the preview dev servers (almostnode's Vite) and answers virtual.request — a script's own server's port it hands to the scripts worker. Never terminated: stopping a script can't take a dev server with it.", "observedBy": "its hub reporter + the Worker probe (non-hub messages)" },
	{ "id": "node-scripts", "label": "Script worker", "container": "workers", "hub": true, "detail": "hub · almostnode, node scripts", "description": "Runs the terminal's node scripts (almostnode) when the debugger doesn't: started for the first, terminated to stop one.", "observedBy": "its hub reporter + the Worker probe (non-hub messages)", "condition": "while a node script runs outside the debugger" },
	{ "id": "debug-worker", "label": "Debug worker", "container": "podWorkers", "hub": true, "detail": "hub · tsval stepping", "description": "One per tsval debug session, spawned by the pod's debug adapter: control and events over the hub on its session's subjects, the render stream straight to the tsval preview.", "observedBy": "its hub reporter + the Worker probe", "condition": "while debugging" },
	{ "id": "worker:server-host", "label": "LSP server host", "container": "podWorkers", "detail": "cspell (vscode-languageclient)", "description": "cspell language server, spawned by the pod — JSON-RPC over postMessage plus a ws-control port for the shared filesystem.", "observedBy": "the Worker probe" },
	{ "id": "classify", "label": "Classify worker", "container": "workers", "hub": true, "detail": "hub · BABLR cosmetic classifier", "description": "Classifies git changes as cosmetic or semantic, and groups edit bursts, for the git SCM and the review panel.", "observedBy": "its hub reporter + the Worker probe", "condition": "when git classifies a change" },
	{ "id": "recognizer", "label": "Recognizer worker", "container": "workers", "hub": true, "detail": "hub · game recognizer", "description": "Recognizes a game's structure for the event sheet view.", "observedBy": "its hub reporter + the Worker probe", "condition": "when the event sheet opens" },
	{ "id": "exthost-iframe", "label": "Iframe relay", "container": "extHostIframe", "detail": "webWorkerExtensionHostIframe.html", "description": "Boots the web worker extension host, relays its first messages and hands its MessagePort to the workbench.", "observedBy": "window message listener" },
	{ "id": "exthost:LocalWebWorker:0", "label": "Worker extension host", "container": "extHostWorker", "detail": "eslint, capabilities, default extensions", "description": "Extension host in a web worker: the default extensions (typescript-language-features and its tsserver), eslint and capabilities.", "observedBy": "RPCProtocol logger + an in-worker probe (its fetches and the workers it spawns)" },
	{ "id": "idb", "label": "IndexedDB", "container": "browser", "detail": "user data, logs, workspace-fs", "description": "monaco's user data / logs / storage, and the workspace filesystem snapshot.", "observedBy": "IDBObjectStore probe" },
	{ "id": "net:origin", "label": "Page origin", "container": "network", "detail": "app, node_modules overlay, ATA", "description": "The app's own server (dev server or Pages): bundles, the node_modules CDN overlay, type acquisition.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:unpkg.com", "label": "unpkg", "container": "network", "detail": "CDN node_modules", "description": "The service worker's upstream for the node_modules overlay.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:registry.npmjs.org", "label": "npm registry", "container": "network", "detail": "type acquisition", "description": "typescript-language-features' automatic type acquisition, from the worker extension host (package metadata for @types lookups).", "observedBy": "the service worker's fetch probe", "condition": "when a file imports a package" },
	{ "id": "zenfs", "label": "Workspace (zen-fs)", "container": "sharedMemory", "detail": "SingleBuffer at /workspace", "description": "The workspace filesystem: a zen-fs SingleBuffer store in a SharedArrayBuffer the workbench creates and hands to the node worker (over the hub) and the cspell server (a control port), which mount it at /workspace. Same bytes in every realm, guarded by an Atomics lock. Shared memory notifies nobody, so each realm watches its own mount's writes and reports them as workspace.changed; the workbench persists every one to IndexedDB and announces it to VS Code, whoever wrote (the provider, isomorphic-git, the terminal, a node script).", "observedBy": "each realm's /workspace mount (zen-fs StoreFS operations), the provider's change events, the workspace-fs IndexedDB" },
	{ "id": "tsval-preview", "label": "tsval preview", "container": "previews", "detail": "debug-preview.html", "description": "The tsval debugger's render surface: announces itself (preview-ready), gets a MessagePort from the shell, streams events up and renders the mutation stream the workbench sends.", "observedBy": "the shell's window message probe + the shell's preview bridge", "condition": "while debugging with tsval" },
	{ "id": "provoke", "label": "Provoke worker", "container": "workers", "hub": true, "detail": "hub · cold-start transform repro", "description": "A throwaway child of the node worker (debug-mcp provoke_transform hardReset): mounts the workspace and transforms modules cold, once.", "observedBy": "its hub reporter + the node worker's Worker probe", "condition": "debug-mcp provoke_transform" },
	{ "id": "net:brianjenkins94.github.io", "label": "GitHub Pages", "container": "network", "detail": "preview packages", "description": "A previewed app's tarball dependencies (a URL in its package.json — e.g. @brianjenkins94/hub), fetched once by the node worker's dev server and served from /@pkg/.", "observedBy": "the service worker's fetch probe", "condition": "when a previewed app depends on a tarball" },
	{ "id": "net:esm.sh", "label": "esm.sh", "container": "network", "detail": "preview dependencies", "description": "The previewed app's bare imports (react, react-dom, react-refresh), mapped by the dev server's import map and fetched by the preview through the service worker.", "observedBy": "the service worker's fetch probe", "condition": "while a preview runs" },
	{ "id": "net:cdn.jsdelivr.net", "label": "jsDelivr", "container": "network", "detail": "preview DevTools", "description": "A preview's DevTools: chobitsu (the CDP implementation added to the previewed page) and Chrome's DevTools frontend (chii's build).", "observedBy": "the service worker's fetch probe", "condition": "while a preview's DevTools is open" },
	{ "id": "net:ka-f.fontawesome.com", "label": "Font Awesome", "container": "network", "detail": "WebAwesome icons", "description": "WebAwesome's default icon library: the shell chrome's wa-icon elements load their SVGs from the Font Awesome kit CDN, through the service worker.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:open-vsx.org", "label": "Open VSX", "container": "network", "detail": "extension gallery", "description": "The extension gallery.", "observedBy": "the service worker's fetch probe", "condition": "when the gallery is queried" },
	{ "id": "net:api.github.com", "label": "GitHub API", "container": "network", "detail": "shell only", "description": "Loading repos and publishing, from the shell (which holds the token).", "observedBy": "the service worker's fetch probe", "condition": "when a GitHub repo is loaded" },
	{ "id": "net:lighter.codehike.org", "label": "Code Hike", "container": "network", "detail": "diff highlighting", "description": "Syntax highlighting for the git review diffs.", "observedBy": "the service worker's fetch probe", "condition": "when a diff opens" },
	{ "id": "debug-mcp", "label": "debug-mcp", "container": "network", "hub": true, "detail": "hub · Node, ws://localhost:7378", "description": "The Node collector + MCP server: receives $sys.log, serves its own tools and every connected tab's page tools to an MCP client.", "observedBy": "root's topology (and its own reporter)", "condition": "npm run debug-mcp" }
];

export const hubLinks: [string, string][] = [
	["shell", "root"],
	// An app's own hubs, in a preview (observability's linkPreviewHost; permissioned, non-transit — shell-preview.ts).
	["shell", "preview:*"],
	["root", "workbench"],
	["root", "sw"],
	["root", "debug-mcp"],
	["workbench", "pod"],
	["workbench", "node"],
	["workbench", "node-scripts"],
	["workbench", "classify"],
	["workbench", "recognizer"],
	["node", "provoke"],
	["pod", "debug-worker"]
];

export const subjects: SubjectFamily[] = [
	{ "pattern": "$sys.log.>", "hubs": ["*"], "description": "Structured logs, to the root collector and debug-mcp." },
	{ "pattern": "$sys.metrics.>", "hubs": ["*"], "description": "The metrics plane: each context's gauges, sampled once a second (editor-metrics.ts), to the pod's bridge for the insights monitor." },
	{ "pattern": "$sys.backlog.log", "hubs": ["root", "debug-mcp", "preview:*"], "description": "A page's startup records, sent once its debug-mcp link can carry them (observability's logBacklog): the editor root's, and a previewed app's through the shell." },
	{ "pattern": "project.>", "hubs": ["shell", "root"], "description": "Project catalog and opening." },
	{ "pattern": "workspace.files", "hubs": ["shell", "root"], "description": "The current project's files." },
	{ "pattern": "workbench.>", "hubs": ["root", "workbench"], "description": "Boot handshake (init, online), saves, project switches, files." },
	{ "pattern": "git.>", "hubs": ["shell", "workbench"], "description": "The git review panel over the git service." },
	{ "pattern": "history.chunks", "hubs": ["shell", "workbench"], "description": "Edit history for the review panel." },
	{ "pattern": "targets.list", "hubs": ["shell", "workbench"], "description": "Run targets." },
	{ "pattern": "run.target", "hubs": ["shell", "workbench", "pod"], "description": "Run a target in a fresh terminal: the run picker's choice, or F5 on a file that serves." },
	{ "pattern": "theme.colorScheme", "hubs": ["shell", "workbench"], "description": "Theme sync." },
	{ "pattern": "dock.>", "hubs": ["shell", "workbench"], "description": "The shell's dock and VS Code's editor area: VS Code's new windows as dock panels (dock.openWindow, dock.closeWindow), and dock panels shown as VS Code editors (dock.hostEditor, dock.closeEditor)." },
	{ "pattern": "preview.>", "hubs": ["shell", "root", "workbench", "node"], "description": "Preview windows, the dev server, HMR." },
	{ "pattern": "preview.decide", "hubs": ["shell", "preview:*"], "description": "A preview window's page tap asks for a capability the service worker can't see (WebSocket, WebRTC) — prompted in that window." },
	{ "pattern": "preview.open", "hubs": ["shell", "preview:*"], "description": "A preview window's page tap hands up a page the app opened as a new window: another preview window." },
	{ "pattern": "virtual.request.*", "hubs": ["sw", "root"], "description": "The service worker's /__virtual__/<tab>/<port>/ requests, addressed to the tab whose root relays them." },
	{ "pattern": "virtual.request", "hubs": ["root", "workbench", "node"], "description": "A preview's requests, answered by the node worker's dev servers." },
	{ "pattern": "capability.decide.*", "hubs": ["sw", "root"], "description": "The service worker's capability decisions, addressed to the tab whose root relays them to its pod." },
	{ "pattern": "workspace.changed", "hubs": ["workbench", "node", "node-scripts"], "description": "Every change a realm makes to the shared workspace — persisted and announced by the workbench; dev servers hot-reload from it." },
	{ "pattern": "workspace.buffer", "hubs": ["workbench", "node", "node-scripts"], "description": "The node workers ask for the shared workspace buffer." },
	{ "pattern": "node.>", "hubs": ["workbench", "pod", "node", "node-scripts"], "description": "Node runs: start, stdout, exit, stdin, and a port it starts listening on (the scripts worker); and a script's own server, asked for by the dev-server worker (node.script.request)." },
	{ "pattern": "runs.>", "hubs": ["workbench", "pod", "root", "shell"], "description": "What's running (runs.ts): every terminal's runs — services and tasks — as the list changes, and its list and stop calls, for the status bar's running list, the run picker and the runs page tool." },
	{ "pattern": "classify.>", "hubs": ["workbench", "classify"], "description": "Cosmetic/semantic verdicts and edit-burst grouping (cancellable)." },
	{ "pattern": "recognizer.project", "hubs": ["workbench", "recognizer"], "description": "Project a game into the event sheet's model." },
	{ "pattern": "provoke.round", "hubs": ["node", "provoke"], "description": "One cold transform round: the workspace buffer in, failures out." },
	{ "pattern": "debug.>", "hubs": ["shell", "workbench", "pod"], "description": "Debug sessions and the toolbar." },
	{ "pattern": "debug.sessions", "hubs": ["pod", "root"], "description": "The live tsval sessions (for this tab's debug_* page tools, served by its root)." },
	{ "pattern": "debug.start", "hubs": ["pod", "root"], "description": "Start a tsval session, answered with its first stop (this tab's debug_start page tool)." },
	{ "pattern": "debug.breakpoints", "hubs": ["pod", "root"], "description": "Replace a file's breakpoints (this tab's debug_breakpoints page tool)." },
	{ "pattern": "debug.session.>", "hubs": ["pod", "debug-worker", "root"], "description": "One tsval session: the adapter ⇄ worker protocol (control, events), and this tab's debug_* page tools stepping, reading or stopping it." },
	{ "pattern": "production.>", "hubs": ["workbench", "pod"], "description": "Production (server) runs." },
	{ "pattern": "tsval.preview.>", "hubs": ["shell", "workbench", "pod", "debug-worker"], "description": "The tsval render surface." },
	{ "pattern": "capability.decide", "hubs": ["pod", "root", "shell"], "description": "Network/IO capability decisions, served by the pod." },
	{ "pattern": "capability.prompt", "hubs": ["pod", "shell"], "description": "Ask the user about a capability, served by the shell." },
	{ "pattern": "pod.ready", "hubs": ["pod", "debug-worker"], "description": "A debug worker is up." },
	{ "pattern": "tab.>", "hubs": ["root", "debug-mcp", "preview:*"], "description": "debug-mcp's tab discovery: which editor tabs are linked, by id." },
	{ "pattern": "page_tools.*", "hubs": ["root", "debug-mcp", "preview:*"], "description": "debug-mcp reads one tab's page-tool manifest (and hears when it changes)." },
	{ "pattern": "tool.>", "hubs": ["root", "debug-mcp", "preview:*"], "description": "debug-mcp calls a tab's page tools — every page's page_eval / page_query, the editor's debugger, provoke and CDP tools (page-tools.ts), an app's own (served under its tab id)." }
];

export const channels: ChannelSpec[] = [
	{ "a": "workbench", "b": "worker:*", "protocol": "WebWorker protocol / postMessage", "transport": "Worker.postMessage", "description": "monaco's editor workers (request/reply/events) and the workbench's own workers." },
	{ "a": "pod", "b": "worker:server-host", "protocol": "LSP (JSON-RPC)", "transport": "Worker.postMessage", "description": "vscode-languageclient to the cspell server, plus a one-shot control port (ws-control) that hands it the shared workspace buffer — the server host has no hub." },
	{ "a": "workbench", "b": "exthost:LocalProcess:*", "protocol": "RPCProtocol", "transport": "in-memory buffers", "description": "MainThread / ExtHost proxies, serialized even in the same realm." },
	{ "a": "workbench", "b": "exthost-iframe", "protocol": "bootstrap handshake", "transport": "window.postMessage", "description": "NLS bootstrap, then the MessagePort handoff." },
	{ "a": "workbench", "b": "exthost:LocalWebWorker:*", "protocol": "RPCProtocol", "transport": "MessagePort (transferred ArrayBuffers)", "description": "MainThread / ExtHost proxies." },
	{ "a": "exthost:LocalWebWorker:*", "b": "nested:*", "protocol": "extension defined (LSP, tsserver)", "transport": "Worker.postMessage", "description": "Workers the web worker extension host's extensions spawn." },
	// The service worker takes EVERY request from the pages and workers it controls (stamping cross-origin isolation,
	// answering its own routes, resolving node_modules from the CDN, gating a preview's data fetches) and makes the
	// upstream one itself — so each context's HTTP goes to `sw`, and only `sw` reaches the network. (WebSockets don't
	// pass through it: debug-mcp.)
	{ "a": "workbench", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "description": "The workbench bundle and its chunks, extension files, the node_modules overlay, type acquisition, the extension gallery." },
	{ "a": "worker:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "description": "Workers loading their assets (onig.wasm, models)." },
	{ "a": "exthost:LocalWebWorker:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "description": "Extensions loading their resources, and TypeScript's automatic type acquisition (npm package metadata)." },
	{ "a": "shell", "b": "sw", "protocol": "HTTP", "transport": "fetch, through the service worker", "description": "GitHub repos and publishing, diff highlighting, WebAwesome's icons." },
	{ "a": "sw", "b": "net:*", "protocol": "HTTP", "transport": "fetch", "description": "Every upstream request: the app's own server, the node_modules CDN, and the APIs the pages and workers call." },
	{ "a": "shell", "b": "net:*", "protocol": "HTTP", "transport": "fetch, before the service worker controls the page", "description": "A first visit on the dev server: the shell renders (its WebAwesome icons, …) before the newly registered service worker claims the page, so those requests go straight out. Once it's controlled, they go through the service worker." },
	{ "a": "workbench", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore", "description": "User data, logs, storage, workspace-fs." },
	// the preview pipeline
	{ "a": "shell", "b": "preview:*", "protocol": "preview bridge", "transport": "window.postMessage", "description": "Into the iframe: HMR updates (vite-hmr). Everything else of a window rides its hub link (the page tap's hub: its console and errors, capability requests and new windows — preview.decide, preview.open)." },
	{ "a": "webview-sw", "b": "webview:*", "protocol": "VS Code webview resources", "transport": "fetch, through VS Code's webview service worker", "description": "A webview's resources by URL (asWebviewUri) — answered with errors here (see webview-sw)." },
	{ "a": "workbench", "b": "webview:*", "protocol": "VS Code webview protocol", "transport": "window.postMessage", "description": "A webview's iframe — the insights Monitor, a Markdown preview: its document set inline, its messages VS Code's webview postMessage (an extension's postMessage/onDidReceiveMessage ride it)." },
	{ "a": "shell", "b": "devtools:*", "protocol": "CDP (Chrome DevTools Protocol)", "transport": "window.postMessage", "description": "A preview's docked DevTools frontend: raw CDP commands up, replies and events down — the shell relays them over the hub (preview.cdp / preview.cdp.event.<window>) to chobitsu in the preview window's page (preview-devtools.ts)." },
	{ "a": "shell", "b": "tsval-preview", "protocol": "tsval render protocol", "transport": "window.postMessage + MessagePort", "description": "preview-ready → init (MessagePort); events and time travel up, the mutation stream down." },
	{ "a": "preview:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, intercepted by the service worker", "description": "Everything under /__virtual__/<tab>/<port>/ (answered by the dev server over the hub), plus the app's own requests (CDN imports pass through; data fetches are capability-gated, failing closed). Same origin and unsandboxed, by necessity — see ARCHITECTURE.md." },
	{ "a": "node", "b": "sw", "protocol": "HTTP", "transport": "fetch", "description": "The dev servers' own requests (their dependencies), like every controlled context's." },
	{ "a": "node-scripts", "b": "sw", "protocol": "capability decision, HTTP", "transport": "synchronous XMLHttpRequest (POST /__capability__/decide), fetch", "description": "Every write/delete a node script makes asks the service worker, which asks the pod (capability.decide); and the worker's own requests, like every controlled context's." },
	{ "a": "node", "b": "vite:*", "protocol": "in-realm calls", "transport": "function calls", "description": "almostnode's in-browser Vite dev server: requests from virtual.request, file changes, HMR updates back." },
	{ "a": "node-scripts", "b": "server:*", "protocol": "in-realm calls", "transport": "function calls", "description": "A node script's own http.createServer, reached from a preview at /__virtual__/<tab>/<port>/ like a dev server (the dev-server worker hands such a port's requests over)." },
	{ "a": "workbench", "b": "channel:vscode-web-state-db-global", "protocol": "VS Code storage sync", "transport": "BroadcastChannel", "description": "VS Code's global web storage (IndexedDB-backed) telling the editor's other tabs what changed." },
	{ "a": "workbench", "b": "channel:vscode-web-state-db-global-shared", "protocol": "VS Code storage sync", "transport": "BroadcastChannel", "description": "VS Code's shared global web storage, the same across tabs." },
	{ "a": "workbench", "b": "channel:vscode.indexedDB.vscode-userdata.changes", "protocol": "VS Code user-data sync", "transport": "BroadcastChannel", "description": "The user-data filesystem (settings, keybindings, snippets) announcing its changes to the editor's other tabs." },
	{ "a": "shell", "b": "channel:__editor_preview_tap__", "protocol": "preview worker tap", "transport": "BroadcastChannel", "description": "A preview's workers' console, errors and capability requests (worker-tap.ts) — a worker can't reach the editor's window — and the shell's answers to them." },
	{ "a": "node", "b": "channel:vite-ws-channel", "protocol": "WebSocket shim", "transport": "BroadcastChannel", "description": "almostnode's ws shim, as the dev servers use it." },
	{ "a": "node-scripts", "b": "channel:vite-ws-channel", "protocol": "WebSocket shim", "transport": "BroadcastChannel", "description": "almostnode's ws shim: a node script's WebSocket server and its clients, within the origin." },
	// the workspace filesystem (shared memory)
	{ "a": "workbench", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (owner)", "description": "The vscode provider (editor, tsserver, ATA, terminal, extensions) and direct callers (isomorphic-git, the terminal's path walk). Back the other way: provider writes announced as file-change events (5ms batches) — writes from other realms, and direct writes, are NOT announced." },
	{ "a": "node", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "description": "almostnode: the preview dev servers' module loading and transforms." },
	{ "a": "node-scripts", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "description": "almostnode: node scripts' module loading and fs." },
	{ "a": "worker:server-host", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "description": "Mounted by the cspell server (documents arrive over LSP, so it's mostly idle)." },
	{ "a": "provoke", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "description": "A cold transform round reads the workspace." },
	{ "a": "zenfs", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore (workspace-fs)", "description": "Provider writes, flushed every 500ms; restored at boot." }
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

function isHubLink(a: string, b: string): boolean {
	return hubLinks.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function findChannel(a: string, b: string): ChannelSpec | undefined {
	return channels.find((channel) => (globMatches(channel.a, a) && globMatches(channel.b, b)) || (globMatches(channel.a, b) && globMatches(channel.b, a)));
}

/** The declared kind of a pair: a hub link, a declared channel, or nothing. */
export function declaredBetween(a: string, b: string): { "type": "hub" } | { "type": "channel"; "spec": ChannelSpec } | undefined {
	if (isHubLink(a, b)) {
		return { "type": "hub" };
	}

	const spec = findChannel(a, b);

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
			const next = x === current ? y : y === current ? x : undefined;

			if (next !== undefined && !previous.has(next)) {
				previous.set(next, current);
				queue.push(next);
			}
		}
	}

	return undefined;
}

const hubIds = [...new Set(hubLinks.flat())];

/** The subject families allowed across the hub link a–b: those whose participants sit on both sides of it. */
export function familiesOnLink(a: string, b: string): SubjectFamily[] {
	return subjects.filter((family) => {
		const participants = family.hubs.includes("*") ? hubIds : family.hubs;

		for (const x of participants) {
			for (const y of participants) {
				const path = x === y ? undefined : treePath(x, y);

				if (path === undefined) {
					continue;
				}

				for (let index = 0; index + 1 < path.length; index += 1) {
					if ((path[index] === a && path[index + 1] === b) || (path[index] === b && path[index + 1] === a)) {
						return true;
					}
				}
			}
		}

		return false;
	});
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
	| { "type": "unexpected-subject"; "a": string; "b": string; "subject": string; "count": number }
	| { "type": "duplicate-peer"; "hub": string; "peer": string; "links": number }
	| { "type": "unknown-node"; "id": string };

/** `hub`: how many of a label's messages rode the hub — only those are subjects; the rest came from probes. */
export interface ObservedChannel { "a": string; "b": string; "labels": Map<string, { "count": number; "hub"?: number }>; "medium"?: string }

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

/** Compare what's observed with the model. */
export function checkConformance(observed: { "nodes": string[]; "channels": ObservedChannel[]; "topology": Map<string, ObservedTopology> }): Violation[] {
	const violations: Violation[] = [];
	// A previewed app's own contexts are its architecture, not the editor's: nothing to check them against.
	const app = appNodes(observed);

	for (const channel of observed.channels.filter((candidate) => !app.has(candidate.a) && !app.has(candidate.b))) {
		const declared = declaredOn(channel);

		if (declared === undefined) {
			violations.push({ "type": "undeclared-channel", "a": channel.a, "b": channel.b });
			continue;
		}

		if (declared.type === "hub") {
			const families = familiesOnLink(channel.a, channel.b);

			for (const [label, stats] of channel.labels) {
				const subject = (stats.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;

				if (subject !== undefined && !families.some((family) => subjectMatches(family.pattern, subject))) {
					violations.push({ "type": "unexpected-subject", "a": channel.a, "b": channel.b, "subject": subject, "count": stats.count });
				}
			}
		}
	}

	for (const [hub, snapshot] of [...observed.topology].filter(([id]) => !app.has(id))) {
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

	for (const id of observed.nodes.filter((candidate) => !app.has(candidate))) {
		const dynamic = DYNAMIC_PREFIXES.some((prefix) => id.startsWith(prefix));

		if (!dynamic && nodeSpec(id) === undefined) {
			violations.push({ "type": "unknown-node", "id": id });
		}
	}

	return violations;
}

/**
 * A previewed app's own context: `<window>/<hub>` — the hub's own id, under the preview window it runs in. An app's hub
 * ids are its own choice (every window of one app has a `page`), so the shell scopes an app's observability as it
 * enters the editor's tree, per window (shell-preview.ts, observability's scopeObservability): its reports and records
 * name its contexts `preview:<port>/<id>` (or `preview:<port>~<n>/<id>` for the port's n-th window).
 */
export function isAppNode(id: string): boolean {
	return /^preview:[^/]+\/./u.test(id);
}

/** The preview window an app context runs in (`preview:<port>` or `preview:<port>~<n>`). */
export function appWindowOf(id: string): string | undefined {
	return isAppNode(id) ? id.slice(0, id.indexOf("/")) : undefined;
}

/** A previewed app's own contexts, among what's observed (isAppNode). None of it is the editor's architecture. */
export function appNodes(observed: { "nodes"?: string[]; "channels": { "a": string; "b": string }[]; "topology": Map<string, ObservedTopology> }): Set<string> {
	return new Set([...observed.nodes ?? [], ...observed.topology.keys(), ...observed.channels.flatMap((channel) => [channel.a, channel.b])].filter(isAppNode));
}

/** Where a reporting hub runs (observability's ArchRealm). */
export interface ObservedRealm { "kind": "window" | "worker"; "url": string; "parent"?: string }

export interface AppLayout {
	/** The previewed apps' contexts (appNodes). */
	"nodes": Set<string>;
	/** Where each app context runs, as its realm says: a frame in the window (or frame) at its parent address, a worker
	 *  under the realm that started it (observability's REALM_PARENT, which the preview's tap sets) — within its own
	 *  preview window, whose page reports as the window itself (`preview:<port>`: the edge names it). */
	"parent": Map<string, string>;
}

/** A preview window's id (`preview:<port>`, `preview:<port>~<n>`): the shell's name for it, and its page's. */
function isWindowNode(id: string): boolean {
	return /^preview:[^/]+$/u.test(id);
}

/**
 * How a previewed app's contexts nest, per preview window — read off what each realm reports, nothing inferred: its
 * parent address names the realm holding (or that started) it, looked up among the realms of the same preview window
 * (two windows of one app have the same addresses). An app context whose parent isn't known sits in its window.
 */
export function appLayout(observed: { "channels": { "a": string; "b": string }[]; "topology": Map<string, ObservedTopology>; "realms": Map<string, ObservedRealm> }): AppLayout {
	const nodes = appNodes(observed);
	const parent = new Map<string, string>();
	const windowOf = (id: string): string => (isWindowNode(id) ? id : appWindowOf(id)!);
	// Each window realm by its address, per preview window — the window itself first, where a realm holds several hubs.
	const byUrl = new Map<string, string>();
	const holders = [...observed.realms].filter(([id, realm]) => realm.kind === "window" && (nodes.has(id) || isWindowNode(id)));

	for (const [id, realm] of holders.toSorted(([a], [b]) => Number(isWindowNode(b)) - Number(isWindowNode(a)))) {
		const key = windowOf(id) + "\0" + realm.url;

		if (!byUrl.has(key)) {
			byUrl.set(key, id);
		}
	}

	for (const id of nodes) {
		const holder = observed.realms.get(id)?.parent;
		const at = holder === undefined ? undefined : byUrl.get(windowOf(id) + "\0" + holder);

		if (at !== undefined && at !== id) {
			parent.set(id, at);
		}
	}

	return { "nodes": nodes, "parent": parent };
}

// ── probes' view of the model ─────────────────────────────────────────────────────────────────────────────────

/** Contexts created at runtime, by id prefix, and where they live. */
export const DYNAMIC_PREFIXES = ["nested:", "worker:", "preview:", "devtools:", "vite:", "server:", "channel:", "lock:", "rtc:", "webview:"];

export function dynamicContainer(id: string): string | undefined {
	if (isAppNode(id)) {
		return "previewApp";
	}

	if (id.startsWith("preview:") || id.startsWith("devtools:")) {
		return "previews";
	}

	if (id.startsWith("webview:")) {
		return "workbenchIframe";
	}

	if (id.startsWith("vite:") || id.startsWith("server:") || id.startsWith("worker:")) {
		return "workers";
	}

	// A realm's channels past its hub (observability's network probes): a BroadcastChannel or a Web Lock, shared within
	// the origin; a peer connection, to another browser.
	if (id.startsWith("channel:") || id.startsWith("lock:")) {
		return "browserChannels";
	}

	if (id.startsWith("rtc:")) {
		return "peers";
	}

	return undefined;
}

/** Node id owning an IndexedDB database, when it isn't the realm that opens it. */
export function idbOwner(database: string): string | undefined {
	return database === "workspace-fs" ? "zenfs" : undefined;
}

/** Identity of a worker created in the workbench realm, by file name (see the monaco probes' `identifyWorker`). */
export function identifyWorker(url: string): { "id": string; "label"?: string; "container": string; "owner"?: string } | undefined {
	const file = url.split(/[?#]/u)[0].split("/").pop() ?? "";

	switch (file) {
		case "node-worker.js":
			// Two of it: the scripts worker, and the dev-server worker (node-runner.ts names its role in its URL).
			return { "id": /[?&]role=scripts\b/u.test(url) ? "node-scripts" : "node", "container": "workers", "owner": "workbench" };
		case "debug-worker.js":
			return { "id": "debug-worker", "container": "podWorkers", "owner": "pod" };
		case "server-host.js":
			return { "id": "worker:server-host", "container": "podWorkers", "owner": "pod" };
		case "classify-worker.js":
			return { "id": "classify", "container": "workers", "owner": "workbench" };
		case "recognizer-worker.js":
			return { "id": "recognizer", "container": "workers", "owner": "workbench" };
		case "provoke-worker.js":
			return { "id": "provoke", "container": "workers", "owner": "node" };
		default:
			return undefined;
	}
}

/** Node id of an HTTP / WebSocket endpoint. */
/**
 * Does a request made here go through the service worker? It takes every request from the pages and workers it
 * controls. A page can ask (`navigator.serviceWorker.controller`); a worker can't (no `navigator.serviceWorker`), and
 * the workers here are controlled (their own imports arrive through it), so a worker counts as going through it. The
 * service worker's own requests go straight out, and so does anything outside a browser (tests).
 */
function viaServiceWorker(): boolean {
	const scope = globalThis as unknown as { "ServiceWorkerGlobalScope"?: new () => unknown; "WorkerGlobalScope"?: unknown; "navigator"?: { "serviceWorker"?: { "controller": unknown } } };

	if (scope.ServiceWorkerGlobalScope !== undefined && globalThis instanceof scope.ServiceWorkerGlobalScope) {
		return false;
	}

	const container = scope.navigator?.serviceWorker;

	return container !== undefined ? container.controller !== null : scope.WorkerGlobalScope !== undefined;
}

export function classifyUrl(url: URL): string {
	// A WebSocket never passes through the service worker.
	if (url.port === "7378" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
		return "debug-mcp";
	}

	if (viaServiceWorker()) {
		return "sw";
	}

	// Routes only the service worker answers (a capability decision, a preview's dev-server request).
	if (url.origin === globalThis.location?.origin && (url.pathname.includes("/__capability__/") || url.pathname.includes("/__virtual__/"))) {
		return "sw";
	}

	return url.origin === globalThis.location?.origin ? "net:origin" : "net:" + url.host;
}

/** A Mermaid flowchart of the DECLARED hub tree + channels (see ARCHITECTURE.md). */
export function declaredMermaid(): string {
	const id = (value: string): string => value.replaceAll(/\W/gu, "_");
	const lines = ["flowchart LR"];
	const writeContainer = (container: ContainerSpec, indent: string): void => {
		lines.push(`${indent}subgraph ${id(container.id)}["${container.label}"]`);

		for (const node of nodes.filter((candidate) => candidate.container === container.id)) {
			lines.push(`${indent}  ${id(node.id)}["${node.label}"]`);
		}

		for (const child of containers.filter((candidate) => candidate.parent === container.id)) {
			writeContainer(child, indent + "  ");
		}

		lines.push(`${indent}end`);
	};

	for (const container of containers.filter((candidate) => candidate.parent === undefined)) {
		writeContainer(container, "  ");
	}

	for (const [a, b] of hubLinks) {
		lines.push(`  ${id(a)} <==>|hub| ${id(b)}`);
	}

	for (const channel of channels.filter((candidate) => !candidate.a.includes("*") && !candidate.b.includes("*"))) {
		lines.push(`  ${id(channel.a)} <-.->|${channel.protocol}| ${id(channel.b)}`);
	}

	return lines.join("\n");
}
