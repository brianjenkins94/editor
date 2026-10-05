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
	{ "id": "stores", "label": "Stores", "caption": "what the editor keeps — tools' files by shape — discovered from what's written and read", "column": 3, "kind": "group" },
	{ "id": "browserChannels", "label": "Browser channels", "caption": "BroadcastChannels and Web Locks — shared by every tab and worker of the origin, past the hub", "column": 3, "kind": "group" },
	{ "id": "peers", "label": "Peer connections", "caption": "WebRTC — straight to another browser, past the service worker", "column": 3, "kind": "group" }
];

export const nodes: NodeSpec[] = [
	{ "id": "shell", "label": "Shell", "container": "shell", "hub": true, "detail": "hub · shell.tsx", "description": "The top window: project picker, top bar, the git review panel and the preview windows. Holds the GitHub token.", "observedBy": "its hub reporter + network probes" },
	{ "id": "root", "label": "Root", "container": "app", "hub": true, "detail": "hub · main.tsx", "description": "The app iframe and the root of the hub tree: serves project.list / workbench.init, bridges the service worker and debug-mcp, hosts the log collector and the preview backend.", "observedBy": "its hub reporter + network probes" },
	{ "id": "sw", "label": "Service worker", "container": "network", "hub": true, "detail": "hub · sw.js", "description": "One per origin, shared by every tab: takes every HTTP request of the pages and workers it controls and makes the upstream one itself — stamping COOP/COEP, serving the CDN node_modules overlay and /__virtual__ previews, gating network access through capability.decide.", "observedBy": "its hub reporter + network probes" },
	{ "id": "webview-sw", "label": "Webview service worker", "container": "network", "detail": "VS Code's, per webview", "description": "VS Code serves a webview's resources through its own service worker, by a per-webview subdomain a single-origin build can't provide: a webview that asks for one (a Markdown preview's stylesheet) gets an error back. Ours load none.", "observedBy": "the webview probe (load-resource / did-load-resource)", "condition": "when a webview loads a resource by URL" },
	{ "id": "workbench", "label": "Workbench", "container": "workbench", "hub": true, "detail": "hub · workbench-entry.tsx", "description": "The monaco-vscode-api boot: services, editors, the main side of every extension host, the git service, run targets.", "observedBy": "its hub reporter + the monaco probes + network probes" },
	{ "id": "exthost:LocalProcess:0", "label": "Local extension host", "container": "workbench", "detail": "worker-pod", "description": "Extension host sharing the workbench realm: worker-pod, the bridge — core's vscode API is its.", "observedBy": "RPCProtocol logger on its ExtensionHostManager" },
	{ "id": "pod", "label": "Pod", "container": "workbench", "hub": true, "detail": "hub · worker-pod extension", "description": "The worker-pod extension's hub (in the LocalProcess extension host): spawns the LSP and debug workers, serves capability.decide.", "observedBy": "its hub reporter" },
	{ "id": "node", "label": "Dev-server worker", "container": "workers", "hub": true, "detail": "hub · almostnode, preview dev servers", "description": "Hosts the preview dev servers (almostnode's Vite) and answers virtual.request — a script's own server's port it hands to the scripts worker. Never terminated: stopping a script can't take a dev server with it.", "observedBy": "its hub reporter + the Worker probe (non-hub messages)" },
	{ "id": "node-scripts", "label": "Script worker", "container": "workers", "hub": true, "detail": "hub · almostnode, node scripts", "description": "Runs the terminal's node scripts (almostnode) when the debugger doesn't: started for the first, terminated to stop one.", "observedBy": "its hub reporter + the Worker probe (non-hub messages)", "condition": "while a node script runs outside the debugger" },
	{ "id": "debug-worker", "label": "Debug worker", "container": "podWorkers", "hub": true, "detail": "hub · tsval stepping", "description": "One per tsval debug session, spawned by the pod's debug adapter: control and events over the hub on its session's subjects, the render stream straight to the tsval preview.", "observedBy": "its hub reporter + the Worker probe", "condition": "while debugging" },
	{ "id": "worker:server-host", "label": "LSP server host", "container": "podWorkers", "detail": "cspell (vscode-languageclient)", "description": "cspell language server, spawned by the pod — JSON-RPC over postMessage plus a ws-control port for the shared filesystem.", "observedBy": "the Worker probe" },
	{ "id": "bablr", "label": "BABLR worker", "container": "workers", "hub": true, "detail": "hub · the editor's BABLR", "description": "The editor's BABLR, off the UI thread: classifies git changes as cosmetic or semantic and groups edit bursts (the git SCM and the review panel), and finds the span ids runtime evidence keys on.", "observedBy": "its hub reporter + the Worker probe", "condition": "when git classifies a change" },
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
	["workbench", "bablr"],
	["node", "provoke"],
	["pod", "debug-worker"]
];

export const subjects: SubjectFamily[] = [
	// ── observability ──
	{ "pattern": "$sys.log.>", "from": ["*"], "to": ["root", "debug-mcp", "shell"], "description": "Structured logs: to the root collector and debug-mcp; a previewed app's to the shell, which files them under its window." },
	{ "pattern": "$sys.metrics.>", "from": ["*"], "to": ["pod", "debug-mcp", "shell"], "description": "The metrics plane: each context's gauges, sampled once a second (editor-metrics.ts), to the pod's bridge for the insights monitor and to debug-mcp; a previewed app's to the shell first." },
	{ "pattern": "$sys.backlog.log", "from": ["root", "preview:*"], "to": ["debug-mcp"], "description": "A page's startup records, sent once its debug-mcp link can carry them (observability's logBacklog): the editor root's, and a previewed app's through the shell." },
	{ "pattern": "tab.discover", "from": ["debug-mcp", "root"], "to": ["root", "preview:*"], "description": "debug-mcp asks which tabs are linked (a preview's app is one, through the shell)." },
	{ "pattern": "tab.here", "from": ["root", "preview:*"], "to": ["debug-mcp"], "description": "A tab answers discovery with its id." },
	{ "pattern": "page_tools.changed", "from": ["root", "shell", "preview:*"], "to": ["debug-mcp"], "description": "A tab's page tools changed (a preview window's page reloaded): re-read its manifest." },
	{ "pattern": "page_tools.*", "from": ["debug-mcp"], "to": ["root", "preview:*"], "description": "debug-mcp reads one tab's page-tool manifest." },
	{ "pattern": "tool.>", "from": ["debug-mcp", "root"], "to": ["root", "preview:*"], "description": "debug-mcp calls a tab's page tools — the editor's (page-tools.ts: page_eval, the debugger, provoke, CDP, profiles, runs), an app's own (served under its tab id)." },
	// ── the shell ⇄ the app and the workbench ──
	{ "pattern": "project.>", "from": ["shell"], "to": ["root"], "description": "The project picker: the catalog (project.list) and opening one." },
	{ "pattern": "workspace.files", "from": ["shell"], "to": ["root"], "description": "The current project's files and active editor, for a commit or a share link." },
	{ "pattern": "workbench.init", "from": ["workbench"], "to": ["root"], "description": "The workbench's boot handshake: what to open." },
	{ "pattern": "workbench.online", "from": ["workbench"], "to": ["root"], "description": "The workbench is up." },
	{ "pattern": "workbench.save", "from": ["workbench"], "to": ["root"], "description": "A save, for the app frame." },
	{ "pattern": "workbench.files", "from": ["root"], "to": ["workbench"], "description": "The app frame asks the workbench for the workspace's files and active editor." },
	{ "pattern": "workbench.openProject", "from": ["root"], "to": ["workbench"], "description": "Switch the workbench to another project." },
	{ "pattern": "git.status", "from": ["shell", "pod"], "to": ["workbench"], "description": "The git service's changes, for the shell's review panel and VS Code's Source Control view (the pod's)." },
	{ "pattern": "git.file", "from": ["shell", "pod"], "to": ["workbench"], "description": "A changed file's two sides." },
	{ "pattern": "git.classify", "from": ["shell"], "to": ["workbench"], "description": "A change's cosmetic/semantic verdicts." },
	{ "pattern": "git.commit", "from": ["shell", "pod"], "to": ["workbench"], "description": "Commit." },
	{ "pattern": "git.discard", "from": ["shell"], "to": ["workbench"], "description": "Discard a change." },
	{ "pattern": "git.changed", "from": ["workbench"], "to": ["shell", "pod"], "description": "The working tree changed: refresh the review panel and the Source Control view." },
	{ "pattern": "history.chunks", "from": ["shell"], "to": ["workbench"], "description": "Edit history for the review panel." },
	{ "pattern": "tasks.list", "from": ["shell"], "to": ["pod"], "description": "What there is to run, for the run picker: VS Code's tasks (the workspace's package.json scripts, its own tasks), through the bridge (launch.ts)." },
	{ "pattern": "tasks.run", "from": ["shell"], "to": ["pod"], "description": "Run one of them, as a VS Code task." },
	{ "pattern": "terminal.run", "from": ["pod"], "to": ["workbench"], "description": "A task's terminal: the pod's task asks core for a just-bash process that runs its command once (worker-pod/tasks.ts → terminal.ts) — VS Code for the web runs tasks only through the provider's own pseudoterminal." },
	{ "pattern": "terminal.out.*", "from": ["workbench"], "to": ["pod"], "description": "Its output, to the task's terminal." },
	{ "pattern": "terminal.exit.*", "from": ["workbench"], "to": ["pod"], "description": "Its exit code: the task's." },
	{ "pattern": "terminal.in.*", "from": ["pod"], "to": ["workbench"], "description": "Typed input, from the task's terminal." },
	{ "pattern": "terminal.stop.*", "from": ["pod"], "to": ["workbench"], "description": "The task's terminal closed: stop it." },
	{ "pattern": "runs.list", "from": ["shell", "root"], "to": ["workbench"], "description": "The core runtime's runs: the run picker's running markers, the runs page tool." },
	{ "pattern": "runs.stop", "from": ["root"], "to": ["workbench"], "description": "Stop a run (the runs page tool)." },
	{ "pattern": "evidence.observed", "from": ["pod"], "to": ["workbench"], "description": "What a debug session observed — its final coverage and what went through its observed sites — with the source that ran, as evidence of its run (evidence.ts)." },
	{ "pattern": "runs.begin", "from": ["pod"], "to": ["workbench"], "description": "A debug session VS Code started (F5, Run and Debug) is a run: its id, for the session's launch config." },
	{ "pattern": "theme.colorScheme", "from": ["shell"], "to": ["workbench"], "description": "Theme sync." },
	{ "pattern": "dock.openWindow", "from": ["workbench"], "to": ["shell"], "description": "A VS Code window opens as a panel of the shell's dock." },
	{ "pattern": "dock.closeWindow", "from": ["workbench"], "to": ["shell"], "description": "Its window closed." },
	{ "pattern": "dock.hostEditor", "from": ["shell"], "to": ["workbench"], "description": "A dock panel shown as a VS Code editor." },
	{ "pattern": "dock.closeEditor", "from": ["shell"], "to": ["workbench"], "description": "That editor closed." },
	// ── previews ──
	{ "pattern": "preview.start", "from": ["root", "workbench"], "to": ["node"], "description": "Start a dev server's preview in the dev-server worker." },
	{ "pattern": "preview.provoke", "from": ["root", "workbench"], "to": ["node"], "description": "A cold transform round, for the provoke page tool." },
	{ "pattern": "preview.open", "from": ["workbench", "shell"], "to": ["shell", "root"], "description": "Open (or resurface) a server's preview window." },
	{ "pattern": "preview.open", "from": ["preview:*"], "to": ["shell"], "description": "A preview window's page tap hands up a page the app opened as a new window: another preview window." },
	{ "pattern": "preview.ready", "from": ["root"], "to": ["shell"], "description": "A server is up at its address: point its windows there." },
	{ "pattern": "preview.close", "from": ["workbench", "shell"], "to": ["root", "workbench", "node", "shell"], "description": "A server stopped, or its last window closed: close its windows, stop its preview." },
	{ "pattern": "preview.hmr.*", "from": ["node"], "to": ["shell", "workbench"], "description": "A dev server's HMR update, into every window of its port." },
	{ "pattern": "evidence.preview", "from": ["preview:*"], "to": ["workbench"], "description": "A preview page's runtime evidence (page-evidence.ts): what its instrumented modules observed, by file and version, its totals since it loaded — folded into its run's evidence (evidence.ts)." },
	{ "pattern": "evidence.level", "from": ["node"], "to": ["workbench"], "description": "A starting dev server asks how much to instrument for runtime evidence (the silo.evidence.previews setting)." },
	{ "pattern": "preview.version", "from": ["workbench"], "to": ["node"], "description": "Core asks a dev server for a module version it instrumented, by its source's blob oid: runtime evidence reads a version's counts against its own text." },
	{ "pattern": "evidence.flush", "from": ["workbench"], "to": ["preview:*"], "description": "Core asks every preview page to report its runtime evidence now (before the preview closes)." },
	{ "pattern": "preview.decide", "from": ["preview:*"], "to": ["shell"], "description": "A preview window's page tap asks for a capability the service worker can't see (WebSocket, WebRTC) — prompted in that window." },
	{ "pattern": "preview.cdp", "from": ["root", "shell"], "to": ["shell"], "description": "A CDP command to a preview window's page: its docked DevTools, the preview_cdp page tool." },
	{ "pattern": "preview.cdp.event.*", "from": ["shell"], "to": ["shell"], "description": "A preview page's CDP events, to its docked DevTools." },
	{ "pattern": "preview.profile", "from": ["root"], "to": ["shell"], "description": "Profile a preview window's page (the preview_profile page tool)." },
	{ "pattern": "preview.profiled", "from": ["shell"], "to": ["workbench"], "description": "A preview ran slow and was profiled: the workbench saves it, source-mapped (profile-files.ts)." },
	{ "pattern": "virtual.request.*", "from": ["sw"], "to": ["root"], "description": "The service worker's /__virtual__/<tab>/<port>/ requests, addressed to the tab whose root relays them." },
	{ "pattern": "virtual.request", "from": ["root", "workbench"], "to": ["node"], "description": "A preview's requests, answered by the dev-server worker." },
	{ "pattern": "node.script.request", "from": ["node"], "to": ["node-scripts"], "description": "A request for a port no dev server has: a running script's own server, in the script worker." },
	// ── the workspace ──
	{ "pattern": "workspace.changed", "from": ["workbench", "node", "node-scripts"], "to": ["workbench", "node", "node-scripts"], "description": "Every change a realm makes to the shared workspace — persisted and announced by the workbench; dev servers hot-reload from it." },
	{ "pattern": "workspace.buffer", "from": ["node", "node-scripts"], "to": ["workbench"], "description": "The node workers ask for the shared workspace buffer." },
	// ── running node ──
	{ "pattern": "node.start", "from": ["workbench"], "to": ["node-scripts", "pod"], "description": "Start a node run in the script worker (the pod records it)." },
	{ "pattern": "node.ready", "from": ["node-scripts"], "to": ["workbench"], "description": "The script worker is subscribed." },
	{ "pattern": "node.out.*", "from": ["node-scripts", "pod"], "to": ["workbench"], "description": "A run's output: the script worker's, or a debug session's (auto-attach)." },
	{ "pattern": "node.exit.*", "from": ["node-scripts", "pod", "workbench"], "to": ["workbench", "pod"], "description": "A run ended: the script worker's, a debug session's, or an interrupted one's (the runner's own) — the pod records it." },
	{ "pattern": "node.stdin.*", "from": ["workbench"], "to": ["node-scripts"], "description": "Typed input, to a running script." },
	{ "pattern": "node.listening.*", "from": ["node-scripts"], "to": ["workbench"], "description": "A running script started listening on a port: it's a service." },
	{ "pattern": "provoke.round", "from": ["node"], "to": ["provoke"], "description": "One cold transform round: the workspace buffer in, failures out." },
	// ── debugging ──
	{ "pattern": "debug.launch", "from": ["workbench"], "to": ["pod"], "description": "Auto-attach: run a terminal's `node <file>` as a tsval debug session." },
	{ "pattern": "debug.stop", "from": ["workbench"], "to": ["pod"], "description": "Stop that session (Ctrl-C)." },
	{ "pattern": "debug.declined.*", "from": ["pod"], "to": ["workbench"], "description": "The debugger couldn't take it: run it plainly." },
	{ "pattern": "debug.state", "from": ["pod"], "to": ["shell"], "description": "The debug toolbar's state, for a preview window's header." },
	{ "pattern": "debug.command", "from": ["shell"], "to": ["pod"], "description": "A preview window header's debug button." },
	{ "pattern": "debug.sessions", "from": ["root"], "to": ["pod"], "description": "The live tsval sessions (this tab's debug_* page tools)." },
	{ "pattern": "debug.start", "from": ["root"], "to": ["pod"], "description": "Start a tsval session, answered with its first stop (debug_start)." },
	{ "pattern": "debug.breakpoints", "from": ["root"], "to": ["pod"], "description": "Replace a file's breakpoints (debug_breakpoints)." },
	{ "pattern": "debug.session.*.control", "from": ["pod"], "to": ["debug-worker"], "description": "One tsval session: the adapter drives its worker." },
	{ "pattern": "debug.session.*.event", "from": ["debug-worker"], "to": ["pod"], "description": "One tsval session: its worker reports stops, output, coverage." },
	{ "pattern": "debug.session.*.state", "from": ["root"], "to": ["pod"], "description": "This tab's debug_state page tool reads one session." },
	{ "pattern": "debug.session.*.step", "from": ["root"], "to": ["pod"], "description": "This tab's debug_step page tool steps one session." },
	{ "pattern": "debug.session.*.stop", "from": ["root"], "to": ["pod"], "description": "This tab's debug_stop page tool stops one session." },
	{ "pattern": "pod.ready", "from": ["debug-worker"], "to": ["pod"], "description": "A debug worker is up." },
	{ "pattern": "production.launch", "from": ["workbench"], "to": ["pod"], "description": "A production (real-runtime) run starts: show it as a debug session." },
	{ "pattern": "production.out.*", "from": ["workbench"], "to": ["pod"], "description": "Its output, for the Debug Console." },
	{ "pattern": "production.exit.*", "from": ["workbench"], "to": ["pod"], "description": "It ended." },
	{ "pattern": "production.stop.*", "from": ["pod"], "to": ["workbench"], "description": "Its debug session's Stop." },
	{ "pattern": "tsval.preview.open", "from": ["pod"], "to": ["shell"], "description": "A tsval session started: open its render surface (tsval-surface.ts)." },
	{ "pattern": "tsval.preview.close", "from": ["pod"], "to": ["shell"], "description": "It ended: close the surface." },
	{ "pattern": "tsval.preview.stream", "from": ["debug-worker", "pod"], "to": ["pod", "shell"], "description": "A tsval session's render stream, to the surface — kept by the pod to replay to a surface that reconnects." },
	{ "pattern": "tsval.preview.hello", "from": ["shell"], "to": ["pod"], "description": "The surface is up: replay the session." },
	{ "pattern": "tsval.preview.event", "from": ["shell"], "to": ["pod"], "description": "A DOM event on the surface, for the session." },
	{ "pattern": "tsval.preview.timeTravel", "from": ["shell"], "to": ["pod"], "description": "Scrub the session's history." },
	// ── capabilities ──
	{ "pattern": "capability.decide.*", "from": ["sw"], "to": ["root"], "description": "The service worker's capability decisions, addressed to the tab whose root relays them to its pod." },
	{ "pattern": "capability.decide", "from": ["root", "shell"], "to": ["pod"], "description": "Network/IO capability decisions, served by the pod." },
	{ "pattern": "capability.prompt", "from": ["pod"], "to": ["shell"], "description": "Ask the user about a capability, served by the shell." },
	// ── workers ──
	{ "pattern": "bablr.>", "from": ["workbench"], "to": ["bablr"], "description": "What bablr.ts asks its BABLR worker for: cosmetic/semantic verdicts, edit-burst grouping (cancellable), a text's spans, the span standing for each of its ranges (a run's evidence), where a span went between two versions of a text, and references to spans and where they are now (annotations)." },
	{ "pattern": "annotations.>", "from": ["pod"], "to": ["workbench"], "description": "Durable annotations on code spans (SPAN-ANNOTATIONS.md), from core's BABLR (bablr.ts): references to ranges' spans, and where references' spans are now — the pod's editor.annotations.* commands, for extensions (the notes, the insights extension's evidence marks, the event sheet's anchors)." }
];

export const channels: ChannelSpec[] = [
	{ "a": "workbench", "b": "worker:*", "protocol": "WebWorker protocol / postMessage", "transport": "Worker.postMessage", "reason": "platform", "description": "monaco's editor workers (request/reply/events) and the workbench's own workers." },
	{ "a": "pod", "b": "worker:server-host", "protocol": "LSP (JSON-RPC)", "transport": "Worker.postMessage", "reason": "platform", "description": "vscode-languageclient to the cspell server, plus a one-shot control port (ws-control) that hands it the shared workspace buffer — the server host has no hub." },
	{ "a": "workbench", "b": "exthost:LocalProcess:*", "protocol": "RPCProtocol", "transport": "in-memory buffers", "reason": "platform", "description": "MainThread / ExtHost proxies, serialized even in the same realm." },
	{ "a": "workbench", "b": "exthost-iframe", "protocol": "bootstrap handshake", "transport": "window.postMessage", "reason": "platform", "description": "NLS bootstrap, then the MessagePort handoff." },
	{ "a": "workbench", "b": "exthost:LocalWebWorker:*", "protocol": "RPCProtocol", "transport": "MessagePort (transferred ArrayBuffers)", "reason": "platform", "description": "MainThread / ExtHost proxies." },
	{ "a": "exthost:LocalWebWorker:*", "b": "nested:*", "protocol": "extension defined (LSP, tsserver)", "transport": "Worker.postMessage", "reason": "platform", "description": "Workers the web worker extension host's extensions spawn: TypeScript's servers, the event sheet's recognizer." },
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
	{ "a": "bablr", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore (bablr)", "reason": "storage", "description": "The BABLR worker's cache of parses, by git blob oid and parse version — derived, its own database (not the workspace's fixed buffer)." },
	// the preview pipeline
	{ "a": "shell", "b": "preview:*", "protocol": "preview bridge", "transport": "window.postMessage", "reason": "isolation", "description": "Into the iframe: HMR updates (vite-hmr). Everything else of a window rides its hub link (the page tap's hub: its console and errors, capability requests and new windows — preview.decide, preview.open — and its workers', which join that hub through their page: worker-tap.ts)." },
	{ "a": "webview-sw", "b": "webview:*", "protocol": "VS Code webview resources", "transport": "fetch, through VS Code's webview service worker", "reason": "platform", "description": "A webview's resources by URL (asWebviewUri) — answered with errors here (see webview-sw)." },
	{ "a": "workbench", "b": "webview:*", "protocol": "VS Code webview protocol", "transport": "window.postMessage", "reason": "platform", "description": "A webview's iframe — the insights Monitor, a Markdown preview: its document set inline, its messages VS Code's webview postMessage (an extension's postMessage/onDidReceiveMessage ride it)." },
	{ "a": "shell", "b": "devtools:*", "protocol": "CDP (Chrome DevTools Protocol)", "transport": "window.postMessage", "reason": "platform", "description": "A preview's docked DevTools frontend: raw CDP commands up, replies and events down — the shell relays them over the hub (preview.cdp / preview.cdp.event.<window>) to chobitsu in the preview window's page (preview-devtools.ts)." },
	{ "a": "shell", "b": "tsval-preview", "protocol": "tsval render protocol", "transport": "window.postMessage + MessagePort", "reason": "bulk data", "description": "preview-ready → init (MessagePort); events and time travel up, the mutation stream down." },
	{ "a": "preview:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, intercepted by the service worker", "reason": "platform", "description": "Everything under /__virtual__/<tab>/<port>/ (answered by the dev server over the hub), plus the app's own requests (CDN imports pass through; data fetches are capability-gated, failing closed). Same origin and unsandboxed, by necessity — see ARCHITECTURE.md." },
	{ "a": "node", "b": "sw", "protocol": "HTTP", "transport": "fetch", "reason": "platform", "description": "The dev servers' own requests (their dependencies), like every controlled context's." },
	{ "a": "node-scripts", "b": "sw", "protocol": "capability decision, HTTP", "transport": "synchronous XMLHttpRequest (POST /__capability__/decide), fetch", "reason": "synchronous", "description": "Every write/delete a node script makes asks the service worker, which asks the pod (capability.decide); and the worker's own requests, like every controlled context's." },
	{ "a": "node", "b": "vite:*", "protocol": "in-realm calls", "transport": "function calls", "reason": "in-realm", "description": "almostnode's in-browser Vite dev server: requests from virtual.request, file changes, HMR updates back." },
	{ "a": "node-scripts", "b": "server:*", "protocol": "in-realm calls", "transport": "function calls", "reason": "in-realm", "description": "A node script's own http.createServer, reached from a preview at /__virtual__/<tab>/<port>/ like a dev server (the dev-server worker hands such a port's requests over)." },
	{ "a": "workbench", "b": "channel:vscode-web-state-db-global", "protocol": "VS Code storage sync", "transport": "BroadcastChannel", "reason": "platform", "description": "VS Code's global web storage (IndexedDB-backed) telling the editor's other tabs what changed." },
	{ "a": "workbench", "b": "channel:vscode-web-state-db-global-shared", "protocol": "VS Code storage sync", "transport": "BroadcastChannel", "reason": "platform", "description": "VS Code's shared global web storage, the same across tabs." },
	{ "a": "workbench", "b": "channel:vscode.indexedDB.vscode-userdata.changes", "protocol": "VS Code user-data sync", "transport": "BroadcastChannel", "reason": "platform", "description": "The user-data filesystem (settings, keybindings, snippets) announcing its changes to the editor's other tabs." },
	// the workspace filesystem (shared memory)
	{ "a": "workbench", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (owner)", "reason": "shared memory", "description": "The vscode provider (editor, tsserver, ATA, terminal, extensions) and direct callers (isomorphic-git, the terminal's path walk). Back the other way: provider writes announced as file-change events (5ms batches) — writes from other realms, and direct writes, are NOT announced." },
	{ "a": "node", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "reason": "shared memory", "description": "almostnode: the preview dev servers' module loading and transforms." },
	{ "a": "node-scripts", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "reason": "shared memory", "description": "almostnode: node scripts' module loading and fs." },
	{ "a": "worker:server-host", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "reason": "shared memory", "description": "Mounted by the cspell server (documents arrive over LSP, so it's mostly idle)." },
	{ "a": "provoke", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "reason": "shared memory", "description": "A cold transform round reads the workspace." },
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

/** A hub link joins a and b — themselves, or the dynamic ids they're one of (`shell` ⇄ `preview:5173` is `preview:*`'s). */
function isHubLink(a: string, b: string): boolean {
	const [x, y] = [hubOf(a) ?? a, hubOf(b) ?? b];

	return hubLinks.some(([one, other]) => (one === x && other === y) || (one === y && other === x));
}

export function findChannel(a: string, b: string): ChannelSpec | undefined {
	return channels.find((channel) => (globMatches(channel.a, a) && globMatches(channel.b, b)) || (globMatches(channel.a, b) && globMatches(channel.b, a)));
}

/** The declared kind of a pair: a hub link, a declared channel, or nothing. */
export function declaredBetween(a: string, b: string): { "type": "hub" } | { "type": "channel"; "spec": ChannelSpec } | { "type": "discovered"; "kind": "commands" | "store" } | undefined {
	if (isHubLink(a, b)) {
		return { "type": "hub" };
	}

	// Discovered rather than declared (DISCOVERED-ARCHITECTURE.md): between extensions is VS Code's command surface, and a
	// store is what's written to it and read from it.
	if (isExtensionNode(a) && isExtensionNode(b)) {
		return { "type": "discovered", "kind": "commands" };
	}

	if (isStoreNode(a) || isStoreNode(b)) {
		return { "type": "discovered", "kind": "store" };
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

/** The hub an observed id is in the tree as: itself, or the dynamic id it's one of (`preview:5173` → `preview:*`). */
function hubOf(id: string): string | undefined {
	return hubIds.find((hub) => hub === id) ?? hubIds.find((hub) => hub.includes("*") && globMatches(hub, id));
}

/** What a hub traffic label is: a call (`git.status()`), its reply (`↩ git.status()`), or an event. */
export type MessageKind = "call" | "reply" | "event";

export function kindOfLabel(label: string): MessageKind {
	return label.startsWith("↩ ") ? "reply" : label.endsWith("()") ? "call" : "event";
}

const expand = (ids: string[]): string[] => (ids.includes("*") ? hubIds : ids);

/**
 * Whether `family` lets a message of `kind` cross the hub link from `a` to `b`: it lies on the tree path from one of the
 * family's senders to one of its receivers, in that direction. An event or a call goes `from` → `to`; a reply, back.
 */
export function familyAllowsHop(family: SubjectFamily, kind: MessageKind, a: string, b: string): boolean {
	const [x, y] = [hubOf(a), hubOf(b)];

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

/** The subject families that cross the hub link a–b at all, either way: the families the link carries. */
export function familiesOnLink(a: string, b: string): SubjectFamily[] {
	return subjects.filter((family) => (["event", "call"] as const).some((kind) => familyAllowsHop(family, kind, a, b) || familyAllowsHop(family, kind, b, a)));
}

/** Which way a family's events and calls cross the link a–b: `→` (a to b), `←`, or `⇄`. */
export function directionOnLink(family: SubjectFamily, a: string, b: string): "→" | "←" | "⇄" | undefined {
	const forward = familyAllowsHop(family, "event", a, b);
	const backward = familyAllowsHop(family, "event", b, a);

	return forward && backward ? "⇄" : forward ? "→" : backward ? "←" : undefined;
}

/** Whether the model lets `label` (a hub message) cross from `a` to `b`. */
export function allowedOnLink(label: string, a: string, b: string): boolean {
	const subject = subjectOfLabel(label);

	return subject === undefined || subjects.some((family) => subjectMatches(family.pattern, subject) && familyAllowsHop(family, kindOfLabel(label), a, b));
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
	| { "type": "unknown-node"; "id": string }
	/** An IndexedDB database nobody declared among the stores: kept out of the design's sight. */
	| { "type": "undeclared-store"; "database": string; "by": string };

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
			for (const [label, stats] of channel.labels) {
				const subject = (stats.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;
				const directed = stats.forward !== undefined || stats.backward !== undefined;

				if (subject === undefined) {
					continue;
				}

				if (!directed) {
					if (!allowedOnLink(label, channel.a, channel.b) && !allowedOnLink(label, channel.b, channel.a)) {
						violations.push({ "type": "unexpected-subject", "a": channel.a, "b": channel.b, "subject": subject, "count": stats.count });
					}

					continue;
				}

				for (const [from, to, count] of [[channel.a, channel.b, stats.forward ?? 0], [channel.b, channel.a, stats.backward ?? 0]] as const) {
					if (count > 0 && !allowedOnLink(label, from, to)) {
						violations.push({ "type": "unexpected-subject", "a": from, "b": to, "subject": subject, "count": count });
					}
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

	// Every IndexedDB database used: declared among the stores (its labels say `<database> › <store>.<operation>`).
	const reported = new Set<string>();

	for (const channel of observed.channels.filter((candidate) => (candidate.a === "idb" || candidate.b === "idb") && !app.has(candidate.a) && !app.has(candidate.b))) {
		for (const label of channel.labels.keys()) {
			const database = label.split(" › ")[0];

			if (database !== label && !declaresDatabase(database) && !reported.has(database)) {
				reported.add(database);
				violations.push({ "type": "undeclared-store", "database": database, "by": channel.a === "idb" ? channel.b : channel.a });
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
export const DYNAMIC_PREFIXES = ["nested:", "worker:", "preview:", "devtools:", "vite:", "server:", "channel:", "lock:", "rtc:", "webview:", "ext:", "store:"];

/** An extension, discovered by its commands (extensions/command-tap.ts): `ext:<name>`, or `ext:vscode` for VS Code's own
 *  commands and its built-in extensions'. */
export function isExtensionNode(id: string): boolean {
	return id.startsWith("ext:");
}

/**
 * A hub's components, discovered (DISCOVERED-ARCHITECTURE.md): its subscriptions grouped by the function that registered
 * them (the hub's `sites`), or — where no name survived the build — by their subject's namespace. A call reads as
 * `name()`; an RPC client's own reply channel is machinery, not a component's.
 */
export function componentsOf(hub: { "subscriptions": string[]; "sites"?: Record<string, string[]> }): { "component": string; "subjects": string[] }[] {
	const components = new Map<string, Set<string>>();

	for (const pattern of hub.subscriptions) {
		if (pattern.startsWith("$rpc.reply.")) {
			continue;
		}

		// A session's, a port's, a tab's own subject (`production.stop.<uuid>`, `preview.hmr.5173`) is one of a kind: `*`.
		const general = pattern.split(".").map((token) => (/^(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})$/u.test(token) ? "*" : token)).join(".");
		const subject = general.startsWith("$rpc.call.") ? general.slice("$rpc.call.".length) + "()" : general;
		const component = hub.sites?.[pattern]?.[0] ?? subject.split(".")[0]!;
		const known = components.get(component) ?? new Set<string>();

		known.add(subject);
		components.set(component, known);
	}

	return [...components].map(([component, subjects]) => ({ "component": component, "subjects": [...subjects].sort() })).sort((a, b) => a.component.localeCompare(b.component));
}

/** A store, discovered by what's written and read in it (architecture-zenfs.ts, storeShape): `store:<shape>`. */
export function isStoreNode(id: string): boolean {
	return id.startsWith("store:");
}

/** What the editor keeps, discovered: each store — a tool's files by shape, or an IndexedDB database — with who wrote it
 *  and who read it, from what was observed (DISCOVERED-ARCHITECTURE.md). */
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

	return [...stores].map(([store, { writers, readers }]) => ({ "store": store, "writers": [...writers].sort(), "readers": [...readers].sort() })).sort((a, b) => a.store.localeCompare(b.store));
}

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

	if (id.startsWith("store:")) {
		return "stores";
	}

	if (id.startsWith("rtc:")) {
		return "peers";
	}

	return undefined;
}

/** Node id owning an IndexedDB database, when it isn't the realm that opens it: the workspace's zen-fs, persisting its
 *  shared buffer (`workspace-fs`) and mounting silo's local/ (`silo-local`). */
export function idbOwner(database: string): string | undefined {
	return database === "workspace-fs" || database === "silo-local" ? "zenfs" : undefined;
}

/**
 * Everything the editor keeps — where, for how long, and what — so no store is out of the design's sight (RUNTIME-
 * EVIDENCE.md; `.git/` holds git's own and nothing else). `where` is a path in the workspace or an IndexedDB database
 * (`idb:<name>`, `*` for any suffix); conformance checks every database the IndexedDB probe sees against these.
 *  - committed: in git, travels with the repo;
 *  - local: this machine only, not derivable (losing it loses something);
 *  - derived: this machine only, a cache (safe to delete at any time);
 *  - platform: VS Code's own.
 */
export interface StoreSpec { "where": string; "kind": "committed" | "local" | "derived" | "platform"; "owner": string; "holds": string }

export const stores: StoreSpec[] = [
	{ "where": ".silo/", "kind": "committed", "owner": "workbench", "holds": "Silo's policy and capability rollups; each run's envelope (runs/) and what runs observed, keyed on BABLR spans (evidence/)." },
	{ "where": ".git/", "kind": "committed", "owner": "workbench", "holds": "Git's own (isomorphic-git): objects, refs, the index, config. Nothing of the editor's." },
	{ "where": ".silo/local/ = idb:silo-local", "kind": "local", "owner": "zenfs", "holds": "A zen-fs mount of its own IndexedDB store (workspace-fs.ts), only in the workbench: each file's edit history (edit-history/) and the newest raw CPU profiles (profiles/). Held in memory too, so each keeps little." },
	{ "where": "idb:workspace-fs", "kind": "local", "owner": "zenfs", "holds": "The workspace's own writes (edits, acquired types), restored over the seed at boot." },
	{ "where": "idb:bablr", "kind": "derived", "owner": "bablr", "holds": "The BABLR worker's parses, by parse version and git blob oid — the browser's .silo/local/bablr/ (bablr-worker.ts). Spans, verdicts and edit groups are all derived from them." },
	{ "where": "idb:vscode-web-db", "kind": "platform", "owner": "workbench", "holds": "VS Code's user data and logs." },
	{ "where": "idb:vscode-web-state-db*", "kind": "platform", "owner": "workbench", "holds": "VS Code's storage (global, shared, per workspace)." }
];

/** Whether the model declares IndexedDB database `name` among the stores. */
export function declaresDatabase(name: string): boolean {
	return stores.some((store) => store.where.split(" = ").some((where) => where.startsWith("idb:") && (where.endsWith("*") ? name.startsWith(where.slice(4, -1)) : name === where.slice(4))));
}

/** The stores, as the table ARCHITECTURE.md shows (generated: the model test checks it). */
export function declaredStoresTable(): string {
	return ["| Where | Kind | Owner | Holds |", "| --- | --- | --- | --- |", ...stores.map((store) => `| \`${store.where}\` | ${store.kind} | ${store.owner} | ${store.holds} |`)].join("\n");
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
		case "bablr-worker.js":
			return { "id": "bablr", "container": "workers", "owner": "workbench" };
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
