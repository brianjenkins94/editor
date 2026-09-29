/**
 * The DECLARED architecture of the editor — the reference the live architecture view checks what it observes
 * against (engine: pure data + functions, node-testable; the view and the probes are the bindings).
 *
 * - `containers`: where code runs (realms, origins), nested like the real thing (workbench iframe ⊃ ext host iframe
 *   ⊃ its worker).
 * - `nodes`: the contexts we expect, by id — hub ids for hub-carrying contexts, probe ids for the rest.
 * - `hubLinks`: the hub TREE. `subjects`: which hubs publish/serve/subscribe each subject family — a family may only
 *   cross the tree links between its participants.
 * - `channels`: the non-hub channels (workers, extension hosts, webviews, network, storage).
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
	{ "id": "serviceWorker", "label": "Service worker", "caption": "one per origin · COOP/COEP, CDN, /__virtual__", "column": 1, "kind": "realm" },
	{ "id": "workbenchIframe", "label": "Workbench iframe", "caption": "/__vscode__/host.html · monaco-vscode-api", "column": 2, "kind": "origin" },
	{ "id": "workbench", "label": "Main thread", "caption": "workbench realm (shared with the LocalProcess extension host)", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "editorWorkers", "label": "Editor workers", "caption": "monaco's dedicated workers", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "workers", "label": "App workers", "caption": "spawned by the workbench realm and the pod", "parent": "workbenchIframe", "kind": "realm" },
	{ "id": "extHostIframe", "label": "Extension host iframe", "caption": "hidden iframe · relays its worker", "parent": "workbenchIframe", "kind": "origin" },
	{ "id": "extHostWorker", "label": "Web worker extension host", "caption": "LocalWebWorker extensions, tsserver", "parent": "extHostIframe", "kind": "realm" },
	{ "id": "webviews", "label": "Webviews", "caption": "an iframe per webview", "parent": "workbenchIframe", "kind": "origin" },
	{ "id": "previews", "label": "Preview windows", "caption": "iframes in the shell · served from /__virtual__/<port>/ by the service worker", "parent": "shell", "kind": "origin" },
	{ "id": "sharedMemory", "label": "Shared memory", "caption": "SharedArrayBuffer · Atomics locks", "column": 3, "kind": "group" },
	{ "id": "browser", "label": "Browser", "caption": "storage", "column": 3, "kind": "group" },
	{ "id": "network", "label": "Network", "caption": "HTTP and WebSockets", "column": 3, "kind": "group" }
];

export const nodes: NodeSpec[] = [
	{ "id": "shell", "label": "Shell", "container": "shell", "hub": true, "detail": "hub · shell.tsx", "description": "The top window: project picker, top bar, the git review panel and the preview windows. Holds the GitHub token.", "observedBy": "its hub reporter + network probes" },
	{ "id": "root", "label": "Root", "container": "app", "hub": true, "detail": "hub · main.tsx", "description": "The app iframe and the root of the hub tree: serves project.list / workbench.init, bridges the service worker and debug-mcp, hosts the log collector and the preview backend.", "observedBy": "its hub reporter + network probes" },
	{ "id": "sw", "label": "Service worker", "container": "serviceWorker", "hub": true, "detail": "hub · coi-serviceworker.js", "description": "Stamps COOP/COEP, serves the CDN node_modules overlay and /__virtual__ previews, gates network access through capability.decide.", "observedBy": "its hub reporter + network probes" },
	{ "id": "workbench", "label": "Workbench", "container": "workbench", "hub": true, "detail": "hub · workbench-entry.tsx", "description": "The monaco-vscode-api boot: services, editors, the main side of every extension host, the git service, run targets.", "observedBy": "its hub reporter + the monaco probes + network probes" },
	{ "id": "exthost:LocalProcess:0", "label": "Local extension host", "container": "workbench", "detail": "hello, worker-pod", "description": "Extension host sharing the workbench realm: the hello extension (the captured vscode API) and worker-pod.", "observedBy": "RPCProtocol logger on its ExtensionHostManager" },
	{ "id": "pod", "label": "Pod", "container": "workbench", "hub": true, "detail": "hub · worker-pod extension", "description": "The worker-pod extension's hub (in the LocalProcess extension host): spawns the LSP and debug workers, serves capability.decide.", "observedBy": "its hub reporter" },
	{ "id": "node", "label": "Node worker", "container": "workers", "hub": true, "detail": "hub · almostnode, preview dev server", "description": "Runs node (almostnode) for the terminal and the preview dev server; answers virtual.request.", "observedBy": "its hub reporter + the Worker probe (non-hub messages)" },
	{ "id": "debug-worker", "label": "Debug worker", "container": "workers", "hub": true, "detail": "hub · tsval stepping", "description": "One per tsval debug session, spawned by the pod's debug adapter: control and events over the hub on its session's subjects, the render stream straight to the tsval preview.", "observedBy": "its hub reporter + the Worker probe", "condition": "while debugging" },
	{ "id": "worker:server-host", "label": "LSP server host", "container": "workers", "detail": "cspell (vscode-languageclient)", "description": "cspell language server, spawned by the pod — JSON-RPC over postMessage plus a ws-control port for the shared filesystem.", "observedBy": "the Worker probe" },
	{ "id": "classify", "label": "Classify worker", "container": "workers", "hub": true, "detail": "hub · BABLR cosmetic classifier", "description": "Classifies git changes as cosmetic or semantic, and groups edit bursts, for the git SCM and the review panel.", "observedBy": "its hub reporter + the Worker probe", "condition": "when git classifies a change" },
	{ "id": "recognizer", "label": "Recognizer worker", "container": "workers", "hub": true, "detail": "hub · game recognizer", "description": "Recognizes a game's structure for the event sheet view.", "observedBy": "its hub reporter + the Worker probe", "condition": "when the event sheet opens" },
	{ "id": "exthost-iframe", "label": "Iframe relay", "container": "extHostIframe", "detail": "webWorkerExtensionHostIframe.html", "description": "Boots the web worker extension host, relays its first messages and hands its MessagePort to the workbench.", "observedBy": "window message listener" },
	{ "id": "exthost:LocalWebWorker:0", "label": "Worker extension host", "container": "extHostWorker", "detail": "eslint, capabilities, default extensions", "description": "Extension host in a web worker: the default extensions (typescript-language-features and its tsserver), eslint and capabilities.", "observedBy": "RPCProtocol logger + an in-worker probe (its fetches and the workers it spawns)" },
	{ "id": "webview-sw", "label": "Webview service worker", "container": "webviews", "detail": "monaco's service-worker.js", "description": "Serves webview resources by asking the workbench (load-resource).", "observedBy": "the webviews' load-resource messages", "condition": "when a webview loads resources" },
	{ "id": "idb", "label": "IndexedDB", "container": "browser", "detail": "user data, logs, workspace-fs", "description": "monaco's user data / logs / storage, and the workspace filesystem snapshot.", "observedBy": "IDBObjectStore probe" },
	{ "id": "net:origin", "label": "Page origin", "container": "network", "detail": "app, node_modules overlay, ATA", "description": "The app's own server (dev server or Pages): bundles, the node_modules CDN overlay, type acquisition.", "observedBy": "fetch probes" },
	{ "id": "net:unpkg.com", "label": "unpkg", "container": "network", "detail": "CDN node_modules", "description": "The service worker's upstream for the node_modules overlay.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:registry.npmjs.org", "label": "npm registry", "container": "network", "detail": "type acquisition", "description": "typescript-language-features' automatic type acquisition, from the worker extension host (package metadata for @types lookups).", "observedBy": "the extension host worker's probe", "condition": "when a file imports a package" },
	{ "id": "zenfs", "label": "Workspace (zen-fs)", "container": "sharedMemory", "detail": "SingleBuffer at /workspace", "description": "The workspace filesystem: a zen-fs SingleBuffer store in a SharedArrayBuffer the workbench creates and hands to the node worker (over the hub) and the cspell server (a control port), which mount it at /workspace. Same bytes in every realm, guarded by an Atomics lock. Shared memory notifies nobody, so each realm watches its own mount's writes and reports them as workspace.changed; the workbench persists every one to IndexedDB and announces it to VS Code, whoever wrote (the provider, isomorphic-git, the terminal, a node script).", "observedBy": "each realm's /workspace mount (zen-fs StoreFS operations), the provider's change events, the workspace-fs IndexedDB" },
	{ "id": "tsval-preview", "label": "tsval preview", "container": "previews", "detail": "debug-preview.html", "description": "The tsval debugger's render surface: announces itself (preview-ready), gets a MessagePort from the shell, streams events up and renders the mutation stream the workbench sends.", "observedBy": "the shell's window message probe + the shell's preview bridge", "condition": "while debugging with tsval" },
	{ "id": "provoke", "label": "Provoke worker", "container": "workers", "hub": true, "detail": "hub · cold-start transform repro", "description": "A throwaway child of the node worker (debug-mcp preview_provoke hardReset): mounts the workspace and transforms modules cold, once.", "observedBy": "its hub reporter + the node worker's Worker probe", "condition": "debug-mcp preview_provoke" },
	{ "id": "net:esm.sh", "label": "esm.sh", "container": "network", "detail": "preview dependencies", "description": "The previewed app's bare imports (react, react-dom, react-refresh), mapped by the dev server's import map and fetched by the preview through the service worker.", "observedBy": "the service worker's fetch probe", "condition": "while a preview runs" },
	{ "id": "net:ka-f.fontawesome.com", "label": "Font Awesome", "container": "network", "detail": "WebAwesome icons", "description": "WebAwesome's default icon library: the shell chrome's wa-icon elements load their SVGs from the Font Awesome kit CDN, through the service worker.", "observedBy": "the service worker's fetch probe" },
	{ "id": "net:open-vsx.org", "label": "Open VSX", "container": "network", "detail": "extension gallery", "description": "The extension gallery.", "observedBy": "fetch probe", "condition": "when the gallery is queried" },
	{ "id": "net:api.github.com", "label": "GitHub API", "container": "network", "detail": "shell only", "description": "Loading repos and publishing, from the shell (which holds the token).", "observedBy": "the shell's fetch probe", "condition": "when a GitHub repo is loaded" },
	{ "id": "net:lighter.codehike.org", "label": "Code Hike", "container": "network", "detail": "diff highlighting", "description": "Syntax highlighting for the git review diffs.", "observedBy": "the shell's fetch probe", "condition": "when a diff opens" },
	{ "id": "debug-mcp", "label": "debug-mcp", "container": "network", "hub": true, "detail": "hub · Node, ws://localhost:7378", "description": "The Node collector + MCP server: receives $sys.log, serves tools (page_eval…) to an MCP client.", "observedBy": "root's topology (and its own reporter)", "condition": "npm run debug-mcp" }
];

export const hubLinks: [string, string][] = [
	["shell", "root"],
	["root", "workbench"],
	["root", "sw"],
	["root", "debug-mcp"],
	["workbench", "pod"],
	["workbench", "node"],
	["workbench", "classify"],
	["workbench", "recognizer"],
	["node", "provoke"],
	["pod", "debug-worker"]
];

export const subjects: SubjectFamily[] = [
	{ "pattern": "$sys.log.>", "hubs": ["*"], "description": "Structured logs, to the root collector and debug-mcp." },
	{ "pattern": "project.>", "hubs": ["shell", "root"], "description": "Project catalog and opening." },
	{ "pattern": "workspace.files", "hubs": ["shell", "root"], "description": "The current project's files." },
	{ "pattern": "workbench.>", "hubs": ["root", "workbench"], "description": "Boot handshake (init, online), saves, project switches, files." },
	{ "pattern": "git.>", "hubs": ["shell", "workbench"], "description": "The git review panel over the git service." },
	{ "pattern": "history.chunks", "hubs": ["shell", "workbench"], "description": "Edit history for the review panel." },
	{ "pattern": "targets.list", "hubs": ["shell", "workbench"], "description": "Run targets." },
	{ "pattern": "run.target", "hubs": ["shell", "workbench"], "description": "Run a target." },
	{ "pattern": "theme.colorScheme", "hubs": ["shell", "workbench"], "description": "Theme sync." },
	{ "pattern": "preview.>", "hubs": ["shell", "root", "workbench", "node"], "description": "Preview windows, the dev server, HMR." },
	{ "pattern": "virtual.request.*", "hubs": ["sw", "root"], "description": "The service worker's /__virtual__/<tab>/<port>/ requests, addressed to the tab whose root relays them." },
	{ "pattern": "virtual.request", "hubs": ["root", "workbench", "node"], "description": "A preview's requests, answered by the node worker's dev servers." },
	{ "pattern": "capability.decide.*", "hubs": ["sw", "root"], "description": "The service worker's capability decisions, addressed to the tab whose root relays them to its pod." },
	{ "pattern": "workspace.changed", "hubs": ["workbench", "node"], "description": "Every change a realm makes to the shared workspace — persisted and announced by the workbench; dev servers hot-reload from it." },
	{ "pattern": "workspace.buffer", "hubs": ["workbench", "node"], "description": "The node worker asks for the shared workspace buffer." },
	{ "pattern": "node.>", "hubs": ["workbench", "pod", "node"], "description": "Node runs: start, stdout, exit, stdin." },
	{ "pattern": "classify.>", "hubs": ["workbench", "classify"], "description": "Cosmetic/semantic verdicts and edit-burst grouping (cancellable)." },
	{ "pattern": "recognizer.project", "hubs": ["workbench", "recognizer"], "description": "Project a game into the event sheet's model." },
	{ "pattern": "provoke.round", "hubs": ["node", "provoke"], "description": "One cold transform round: the workspace buffer in, failures out." },
	{ "pattern": "debug.>", "hubs": ["shell", "workbench", "pod"], "description": "Debug sessions and the toolbar." },
	{ "pattern": "debug.sessions", "hubs": ["pod", "root"], "description": "The live tsval sessions (debug-mcp's, forwarded by this tab's root)." },
	{ "pattern": "debug.start", "hubs": ["pod", "root"], "description": "Start a tsval session, answered with its first stop (debug-mcp's, forwarded by this tab's root)." },
	{ "pattern": "debug.breakpoints", "hubs": ["pod", "root"], "description": "Replace a file's breakpoints (debug-mcp's, forwarded by this tab's root)." },
	{ "pattern": "debug.sessions.*", "hubs": ["root", "debug-mcp"], "description": "debug-mcp: one tab's tsval sessions." },
	{ "pattern": "debug.start.*", "hubs": ["root", "debug-mcp"], "description": "debug-mcp: start a tsval session in one tab." },
	{ "pattern": "debug.breakpoints.*", "hubs": ["root", "debug-mcp"], "description": "debug-mcp: replace a file's breakpoints in one tab." },
	{ "pattern": "debug.session.>", "hubs": ["pod", "debug-worker", "debug-mcp"], "description": "One tsval session: the adapter ⇄ worker protocol (control, events), and debug-mcp stepping, reading or stopping it." },
	{ "pattern": "production.>", "hubs": ["workbench", "pod"], "description": "Production (server) runs." },
	{ "pattern": "tsval.preview.>", "hubs": ["shell", "workbench", "pod", "debug-worker"], "description": "The tsval render surface." },
	{ "pattern": "capability.decide", "hubs": ["pod", "root", "shell"], "description": "Network/IO capability decisions, served by the pod." },
	{ "pattern": "capability.prompt", "hubs": ["pod", "shell"], "description": "Ask the user about a capability, served by the shell." },
	{ "pattern": "pod.ready", "hubs": ["pod", "debug-worker"], "description": "A debug worker is up." },
	{ "pattern": "editor.ready", "hubs": ["pod"], "description": "Published by the pod — nothing subscribes yet." },
	{ "pattern": "tab.>", "hubs": ["root", "debug-mcp"], "description": "debug-mcp's tab discovery: which editor tabs are linked, by id." },
	{ "pattern": "page_eval.*", "hubs": ["root", "debug-mcp"], "description": "debug-mcp tool: evaluate in one tab's page." },
	{ "pattern": "page_query.*", "hubs": ["root", "debug-mcp"], "description": "debug-mcp tool: query the DOM." },
	{ "pattern": "preview_provoke.*", "hubs": ["root", "debug-mcp"], "description": "debug-mcp tool: provoke one tab's preview (forwarded to preview.provoke)." }
];

export const channels: ChannelSpec[] = [
	{ "a": "workbench", "b": "worker:*", "protocol": "WebWorker protocol / postMessage", "transport": "Worker.postMessage", "description": "monaco's editor workers (request/reply/events) and the workbench's own workers." },
	{ "a": "pod", "b": "worker:server-host", "protocol": "LSP (JSON-RPC)", "transport": "Worker.postMessage", "description": "vscode-languageclient to the cspell server, plus a one-shot control port (ws-control) that hands it the shared workspace buffer — the server host has no hub." },
	{ "a": "workbench", "b": "exthost:LocalProcess:*", "protocol": "RPCProtocol", "transport": "in-memory buffers", "description": "MainThread / ExtHost proxies, serialized even in the same realm." },
	{ "a": "workbench", "b": "exthost-iframe", "protocol": "bootstrap handshake", "transport": "window.postMessage", "description": "NLS bootstrap, then the MessagePort handoff." },
	{ "a": "workbench", "b": "exthost:LocalWebWorker:*", "protocol": "RPCProtocol", "transport": "MessagePort (transferred ArrayBuffers)", "description": "MainThread / ExtHost proxies." },
	{ "a": "exthost:LocalWebWorker:*", "b": "nested:*", "protocol": "extension defined (LSP, tsserver)", "transport": "Worker.postMessage", "description": "Workers the web worker extension host's extensions spawn." },
	{ "a": "workbench", "b": "webview:*", "protocol": "webview protocol", "transport": "MessagePort", "description": "Content, extension messages, resource loading, focus and keyboard." },
	{ "a": "webview-sw", "b": "webview:*", "protocol": "resource loading", "transport": "ServiceWorker.postMessage", "description": "Resource requests relayed to the workbench." },
	{ "a": "workbench", "b": "net:origin", "protocol": "HTTP", "transport": "fetch", "description": "node_modules overlay, type acquisition, extension files." },
	{ "a": "worker:*", "b": "net:origin", "protocol": "HTTP", "transport": "fetch", "description": "Workers loading their assets (onig.wasm, models)." },
	{ "a": "exthost:LocalWebWorker:*", "b": "net:origin", "protocol": "HTTP", "transport": "fetch", "description": "Extensions loading their resources." },
	{ "a": "exthost:LocalWebWorker:*", "b": "net:registry.npmjs.org", "protocol": "HTTP", "transport": "fetch", "description": "TypeScript's automatic type acquisition (package metadata)." },
	{ "a": "workbench", "b": "net:open-vsx.org", "protocol": "HTTP", "transport": "fetch", "description": "Extension gallery." },
	{ "a": "shell", "b": "net:api.github.com", "protocol": "HTTP", "transport": "fetch", "description": "GitHub repos and publishing." },
	{ "a": "shell", "b": "net:lighter.codehike.org", "protocol": "HTTP", "transport": "fetch", "description": "Diff highlighting." },
	{ "a": "sw", "b": "net:*", "protocol": "HTTP", "transport": "fetch", "description": "The service worker's upstream requests (CDN)." },
	{ "a": "workbench", "b": "idb", "protocol": "IndexedDB", "transport": "IDBObjectStore", "description": "User data, logs, storage, workspace-fs." },
	// the preview pipeline
	{ "a": "shell", "b": "preview:*", "protocol": "preview bridge", "transport": "window.postMessage", "description": "Into the iframe: HMR updates (vite-hmr), capability decisions. Out of it: console/errors (obs-log → $sys.log.preview), WebSocket/WebRTC capability requests (cap-decide)." },
	{ "a": "shell", "b": "tsval-preview", "protocol": "tsval render protocol", "transport": "window.postMessage + MessagePort", "description": "preview-ready → init (MessagePort); events and time travel up, the mutation stream down." },
	{ "a": "preview:*", "b": "sw", "protocol": "HTTP", "transport": "fetch, intercepted by the service worker", "description": "Everything under /__virtual__/<port>/ (answered by the dev server over the hub), plus the app's own requests (CDN imports pass through; data fetches are capability-gated, failing closed). Same origin and unsandboxed, by necessity — see ARCHITECTURE.md." },
	{ "a": "node", "b": "sw", "protocol": "capability decision", "transport": "synchronous XMLHttpRequest (POST /__capability__/decide)", "description": "Every write/delete a node script makes asks the service worker, which asks the pod (capability.decide)." },
	{ "a": "node", "b": "vite:*", "protocol": "in-realm calls", "transport": "function calls", "description": "almostnode's in-browser Vite dev server: requests from virtual.request, file changes, HMR updates back." },
	{ "a": "node", "b": "server:*", "protocol": "in-realm calls", "transport": "function calls", "description": "A node script's own http.createServer, reached from a preview at /__virtual__/<port>/ like a dev server." },
	// the workspace filesystem (shared memory)
	{ "a": "workbench", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (owner)", "description": "The vscode provider (editor, tsserver, ATA, terminal, extensions) and direct callers (isomorphic-git, the terminal's path walk). Back the other way: provider writes announced as file-change events (5ms batches) — writes from other realms, and direct writes, are NOT announced." },
	{ "a": "node", "b": "zenfs", "protocol": "zen-fs", "transport": "SharedArrayBuffer (mounted)", "description": "almostnode: module loading, node scripts' fs, the preview dev server's transforms." },
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
export interface ObservedChannel { "a": string; "b": string; "labels": Map<string, { "count": number; "hub"?: number }> }
export interface ObservedTopology { "links": { "peerId"?: string }[] }

/** How many observed pairs each declared channel covers. A channel declared on a hub-linked pair (raw messages beside
 *  the hub link, on the same worker) is seen only through probe traffic — the hub's own belongs to the link. */
export function seenChannels(observed: ObservedChannel[]): Map<ChannelSpec, number> {
	const seen = new Map<ChannelSpec, number>();

	for (const channel of observed) {
		const spec = findChannel(channel.a, channel.b);
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

	for (const channel of observed.channels) {
		const declared = declaredBetween(channel.a, channel.b);

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

// ── probes' view of the model ─────────────────────────────────────────────────────────────────────────────────

/** Contexts created at runtime, by id prefix, and where they live. */
export const DYNAMIC_PREFIXES = ["webview:", "nested:", "worker:", "preview:", "vite:", "server:"];

export function dynamicContainer(id: string): string | undefined {
	if (id.startsWith("preview:")) {
		return "previews";
	}

	if (id.startsWith("vite:") || id.startsWith("server:") || id.startsWith("worker:")) {
		return "workers";
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
			return { "id": "node", "container": "workers", "owner": "workbench" };
		case "debug-worker.js":
			return { "id": "debug-worker", "container": "workers", "owner": "pod" };
		case "server-host.js":
			return { "id": "worker:server-host", "container": "workers", "owner": "pod" };
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
export function classifyUrl(url: URL): string {
	if (url.port === "7378" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
		return "debug-mcp";
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
