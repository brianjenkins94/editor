/**
 * The live architecture view (binding): draws the ArchitectureStore — fed by every context's `$sys.arch` reports
 * over the hub tree — against the declared model (architecture-model.ts). Boxes are realms/origins, nodes are
 * contexts, solid double lines are hub links, thin lines probed channels, dots the messages flowing. Declared but
 * idle channels are dashed; anything observed that the model doesn't declare is red.
 *
 * Plain DOM/SVG in the workbench realm (hosted by the component's editor pane), themed with VS Code's variables.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import type { ChannelStats, FlowMessage, RuntimeNode, StoredSample, TrafficKind } from "@brianjenkins94/observability";
import type { ContainerSpec, Violation } from "./architecture-model";
import { ArchitectureStore, collectArchReports, flowsOf, requestArchSync } from "@brianjenkins94/observability";
import type { AppLayout } from "./architecture-model";
import { allowedOnLink, appLayout, appWindowOf, checkConformance, componentsOf, containers, declaredBetween, channels as declaredChannels, declaredOn, declaredMermaid, nodes as declaredNodes, directionOnLink, DYNAMIC_PREFIXES, dynamicContainer, familiesOnLink, hubLinks, nodeSpec, seenChannels, subjectOfLabel, subjectMatches, subjects as subjectFamilies } from "./architecture-model";
import css from "./architecture-view.css?raw";
import { windowTitle } from "./virtual-path";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_HEIGHT = 44;
const NODE_WIDTH = 210;
const GAP = 8;
const PADDING = 10;
const HEADER = 34;

/** A box's header height: a box that stands for a node gets a node box's height, so its dot, label and caption sit as
 *  a node's do. */
function headerOf(container: ContainerSpec): number {
	return container.node === undefined ? HEADER : NODE_HEIGHT;
}
const COLUMN_GAP = 150;
const COLUMN_V_GAP = 22;
const MARGIN = 16;
const HIDE_ENDED_AFTER_MS = 30_000;
const PULSE_DURATION_MS = 650;
const MAX_PULSES = 300;
const MAX_PULSES_PER_EDGE = 6;
const TICK_MS = 500;

const KINDS: TrafficKind[] = ["request", "reply", "event", "message", "error"];

// ── the store: one per workbench, kept across pane close/reopen so history survives ──────────────────────────

let shared: ArchitectureStore | undefined;
// Payload capture (opt-in: it records the app's data) — every reporter's sampled messages keep what they carried. The
// reporters' setting, so one for every view of it.
let capturing = false;

/** The workbench's architecture store — created on first use: subscribes to every reporter and asks for a sync. */
export function architectureStore(hub: Hub): ArchitectureStore {
	if (shared === undefined) {
		const store = new ArchitectureStore();

		shared = store;
		collectArchReports(hub, (report) => {
			// While capturing, a reporter that's new to us (a worker just started) is told too.
			if (capturing && !store.reporters.has(report.reporter)) {
				requestArchSync(hub, { "capture": true });
			}

			store.apply(report);
		});
		// The subscription's interest has to reach the other hubs before they're asked to answer.
		setTimeout(() => { requestArchSync(hub); }, 200);
		// A handle for scripts (the architecture smoke test, a console): what the diagram knows, as data.
		const rpc = createRpcClient(hub);

		(globalThis as unknown as { "__architecture": ArchitectureHandle }).__architecture = {
			"hub": hub,
			"request": async (subject, data, timeoutMs) => rpc.request(subject, data, { "timeoutMs": timeoutMs, "waitForResponderMs": 5000 }),
			"snapshot": () => store.snapshot(),
			"conformance": () => conformanceOf(store)
		};
	}

	return shared;
}

export interface ArchitectureHandle {
	"hub": Hub;
	/** An RPC into the hub tree (e.g. `preview.provoke` on the node worker), for a script driving the editor. */
	"request": (subject: string, data?: unknown, timeoutMs?: number) => Promise<unknown>;
	"snapshot": () => unknown;
	"conformance": () => Violation[];
}

/** What needs review in what the diagram shows: a context that ended long ago (and its channels) no longer does. */
function conformanceOf(store: ArchitectureStore): Violation[] {
	const now = Date.now();

	store.sweep(now);

	// (A medium drawn as an edge isn't a context: its edge is checked against the medium's declaration instead.)
	const shown = new Set([...store.nodes.values()].filter((node) => node.state !== "declared" && !store.media().has(node.id) && isVisible(node, now, false)).map((node) => node.id));

	return checkConformance({
		"nodes": [...shown],
		"channels": [...store.channels.values()].filter((channel) => (channel.count > 0 || channel.linked) && shown.has(channel.a) && shown.has(channel.b)),
		"topology": store.topology
	});
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | undefined> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);

	for (const [name, value] of Object.entries(attributes ?? {})) {
		if (value !== undefined) {
			element.setAttribute(name, value);
		}
	}

	for (const child of children) {
		if (child !== null && child !== undefined && child !== false) {
			element.append(child);
		}
	}

	return element;
}

function s<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number | undefined> = {}, text?: string): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG_NS, tag);

	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) {
			element.setAttribute(name, String(value));
		}
	}

	if (text !== undefined) {
		element.textContent = text;
	}

	return element;
}

function formatCount(count: number): string {
	if (count < 1000) {
		return String(Math.round(count));
	}

	return count < 1_000_000 ? (count / 1000).toFixed(count < 10_000 ? 1 : 0) + "k" : (count / 1_000_000).toFixed(1) + "M";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return bytes + " B";
	}

	return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatRate(rate: number): string {
	return rate >= 10 ? Math.round(rate) + "/s" : rate.toFixed(1) + "/s";
}

function formatTime(t: number): string {
	const date = new Date(t);

	return date.toLocaleTimeString([], { "hour12": false }) + "." + String(date.getMilliseconds()).padStart(3, "0");
}

function containerOf(node: RuntimeNode, app: ReadonlySet<string> = new Set()): string {
	// A previewed app's own context (see appNodes): in its preview, not wherever an unknown context would land.
	if (app.has(node.id)) {
		return "previewApp";
	}

	const declared = nodeSpec(node.id)?.container ?? node.spec.container;

	if (declared !== undefined && containers.some((container) => container.id === declared)) {
		return declared;
	}

	if (node.id.startsWith("net:")) {
		return "network";
	}

	return dynamicContainer(node.id) ?? "workbench";
}

function labelOf(store: ArchitectureStore, id: string): string {
	const window = appWindowOf(id);

	// A previewed app's context by its own name — its window says which preview it's in (detailOf).
	return nodeSpec(id)?.label ?? store.nodes.get(id)?.spec.label ?? (window === undefined ? id : id.slice(window.length + 1));
}

function detailOf(node: RuntimeNode): string {
	const window = appWindowOf(node.id);

	return nodeSpec(node.id)?.detail ?? node.spec.detail ?? node.spec.role ?? (window === undefined ? "" : "in " + windowTitle(window));
}


/** A context the model doesn't list: a previewed app's own, created at runtime (its channels are declared by prefix),
 *  or a finding. */
function undeclaredNote(id: string, app: ReadonlySet<string>): HTMLElement {
	if (app.has(id)) {
		return h("p", { "class": "arch-muted" }, "The previewed app's own context — its hubs joined the editor's tree through the shell's preview link. Its architecture, not the editor's: nothing in the model to check it against.");
	}

	const prefix = DYNAMIC_PREFIXES.find((candidate) => id.startsWith(candidate));

	return prefix === undefined
		? h("p", { "class": "arch-violations" }, "Not in the model.")
		: h("p", { "class": "arch-muted" }, "Created at runtime — the model declares its channels as " + prefix + "*.");
}

function isVisible(node: RuntimeNode, now: number, showDeclared: boolean): boolean {
	if (node.state === "declared") {
		return showDeclared && node.spec.dynamic !== true;
	}

	if (node.spec.dynamic === true && node.state === "terminated" && node.endedAt !== undefined) {
		return now - node.endedAt < HIDE_ENDED_AFTER_MS;
	}

	return true;
}

// ── layout ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rect { "x": number; "y": number; "width": number; "height": number }
interface Layout {
	"width": number;
	"height": number;
	"nodes": Map<string, Rect>;
	"containers": Map<string, Rect>;
	/** Nodes inside a collapsed box (at any depth): node id → that box. Their rect is the box's header. */
	"hidden": Map<string, string>;
}

const COLLAPSED_KEY = "architecture.collapsed";

/** Which collapsible boxes are collapsed: each box's default (ContainerSpec.collapsed), then what this viewer toggled. */
function loadCollapsed(): Set<string> {
	const result = new Set(containers.filter((container) => container.collapsed === true).map((container) => container.id));

	try {
		const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Record<string, boolean>;

		for (const [id, value] of Object.entries(stored)) {
			if (value) {
				result.add(id);
			} else {
				result.delete(id);
			}
		}
	} catch {
		// no storage: the defaults
	}

	return result;
}

function saveCollapsed(collapsed: ReadonlySet<string>): void {
	try {
		localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Object.fromEntries(containers.filter((container) => container.collapsed !== undefined).map((container) => [container.id, collapsed.has(container.id)]))));
	} catch {
		// no storage: this viewer's toggles last until reload
	}
}

/** Nodes drawn as a box of their own container (ContainerSpec.node) rather than a row inside it: node id → container. */
const drawnAsContainer = new Map(containers.filter((container) => container.node !== undefined).map((container) => [container.node!, container.id]));

/** How far a previewed app's context is indented in its box, per level it's nested (see appLayout). */
const APP_INDENT = 14;

function computeLayout(visible: RuntimeNode[], collapsed: ReadonlySet<string>, appInfo: AppLayout): Layout {
	const app = appInfo.nodes;
	const order = new Map(declaredNodes.map((node, index) => [node.id, index]));
	const byContainer = new Map<string, RuntimeNode[]>();
	const visibleIds = new Set(visible.map((node) => node.id));

	for (const node of visible) {
		if (drawnAsContainer.has(node.id)) {
			continue;
		}

		const list = byContainer.get(containerOf(node, app)) ?? [];

		list.push(node);
		byContainer.set(containerOf(node, app), list);
	}

	for (const list of byContainer.values()) {
		list.sort((a, b) => ((order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)) || a.id.localeCompare(b.id));
	}

	// A previewed app's contexts, as the tree they run in: each under the window (or preview) holding it, indented.
	const depth = new Map<string, number>();
	const appList = byContainer.get("previewApp");

	if (appList !== undefined) {
		const inBox = new Set(appList.map((node) => node.id));
		const childrenOf = (id: string | undefined): RuntimeNode[] => appList.filter((node) => {
			const holder = appInfo.parent.get(node.id);

			return id === undefined ? holder === undefined || !inBox.has(holder) : holder === id;
		});
		const ordered: RuntimeNode[] = [];
		const walk = (list: RuntimeNode[], level: number): void => {
			// Workers before frames, each by id.
			for (const node of list.toSorted((a, b) => Number(a.id.includes(".")) - Number(b.id.includes(".")) || a.id.localeCompare(b.id))) {
				if (!depth.has(node.id)) {
					depth.set(node.id, level);
					ordered.push(node);
					walk(childrenOf(node.id), level + 1);
				}
			}
		};

		walk(childrenOf(undefined), 0);
		byContainer.set("previewApp", [...ordered, ...appList.filter((node) => !depth.has(node.id))]);
	}

	const children = (container: ContainerSpec): ContainerSpec[] => containers.filter((candidate) => candidate.parent === container.id);
	const sizes = new Map<string, { "width": number; "height": number }>();
	const measure = (container: ContainerSpec): { "width": number; "height": number } => {
		if (collapsed.has(container.id)) {
			const size = { "width": NODE_WIDTH + PADDING * 2, "height": HEADER };

			sizes.set(container.id, size);

			return size;
		}

		const items = [
			...(byContainer.get(container.id) ?? []).map(() => ({ "width": NODE_WIDTH, "height": NODE_HEIGHT })),
			...children(container).map(measure)
		];
		const width = Math.max(NODE_WIDTH, ...items.map((item) => item.width));
		const height = headerOf(container) + items.reduce((sum, item, index) => sum + item.height + (index > 0 ? GAP : 0), 0);
		const size = { "width": width + PADDING * 2, "height": height + PADDING };

		sizes.set(container.id, size);

		return size;
	};

	const layout: Layout = { "width": 0, "height": 0, "nodes": new Map(), "containers": new Map(), "hidden": new Map() };
	// A collapsed box's nodes, and its nested boxes', all stand at its header.
	const hide = (container: ContainerSpec, box: string, header: Rect): void => {
		for (const node of byContainer.get(container.id) ?? []) {
			layout.nodes.set(node.id, header);
			layout.hidden.set(node.id, box);
		}

		for (const child of children(container)) {
			hide(child, box, header);
		}
	};
	const place = (container: ContainerSpec, x: number, y: number, width: number): void => {
		layout.containers.set(container.id, { "x": x, "y": y, "width": width, "height": sizes.get(container.id).height });

		if (collapsed.has(container.id)) {
			hide(container, container.id, { "x": x, "y": y, "width": width, "height": HEADER });

			return;
		}

		// A box that stands for a node: the node's lines meet the box's header.
		if (container.node !== undefined && visibleIds.has(container.node)) {
			layout.nodes.set(container.node, { "x": x, "y": y, "width": width, "height": headerOf(container) });
		}

		let cursor = y + headerOf(container);
		const inner = width - PADDING * 2;

		for (const node of byContainer.get(container.id) ?? []) {
			const indent = (depth.get(node.id) ?? 0) * APP_INDENT;

			layout.nodes.set(node.id, { "x": x + PADDING + indent, "y": cursor, "width": inner - indent, "height": NODE_HEIGHT });
			cursor += NODE_HEIGHT + GAP;
		}

		for (const child of children(container)) {
			place(child, x + PADDING, cursor, inner);
			cursor += sizes.get(child.id).height + GAP;
		}
	};

	const columns = new Map<number, ContainerSpec[]>();

	for (const container of containers.filter((candidate) => candidate.parent === undefined)) {
		measure(container);
		columns.set(container.column ?? 0, [...columns.get(container.column ?? 0) ?? [], container]);
	}

	const sorted = [...columns.entries()].sort(([a], [b]) => a - b).map(([, list]) => list);
	const heights = sorted.map((list) => list.reduce((sum, container) => sum + sizes.get(container.id).height, 0) + (list.length - 1) * COLUMN_V_GAP);
	const tallest = Math.max(...heights);
	let x = MARGIN;

	sorted.forEach((list, index) => {
		const width = Math.max(...list.map((container) => sizes.get(container.id).width));
		let y = MARGIN + (tallest - heights[index]) / 2;

		for (const container of list) {
			place(container, x, y, width);
			y += sizes.get(container.id).height + COLUMN_V_GAP;
		}

		x += width + COLUMN_GAP;
	});
	layout.width = x - COLUMN_GAP + MARGIN;
	layout.height = tallest + MARGIN * 2;

	return layout;
}

function edgePath(from: Rect, to: Rect): string {
	const fromCenter = from.x + from.width / 2;
	const toCenter = to.x + to.width / 2;
	const fromY = from.y + from.height / 2;
	const toY = to.y + to.height / 2;

	if (Math.abs(toCenter - fromCenter) < 40) {
		const x1 = from.x + from.width;
		const x2 = to.x + to.width;
		const bulge = 30 + Math.abs(toY - fromY) * 0.25;

		return `M ${x1} ${fromY} C ${x1 + bulge} ${fromY} ${x2 + bulge} ${toY} ${x2} ${toY}`;
	}

	const leftToRight = toCenter > fromCenter;
	const x1 = leftToRight ? from.x + from.width : from.x;
	const x2 = leftToRight ? to.x : to.x + to.width;
	const curve = Math.max(40, Math.abs(x2 - x1) / 2);

	return `M ${x1} ${fromY} C ${leftToRight ? x1 + curve : x1 - curve} ${fromY} ${leftToRight ? x2 - curve : x2 + curve} ${toY} ${x2} ${toY}`;
}

/** Mermaid of what's OBSERVED (the declared one is `declaredMermaid`). */
function observedMermaid(store: ArchitectureStore): string {
	const id = (value: string): string => value.replaceAll(/\W/gu, "_");
	const lines = ["flowchart LR"];

	for (const node of store.nodes.values()) {
		if (node.state !== "declared" && !store.media().has(node.id)) {
			lines.push(`  ${id(node.id)}["${labelOf(store, node.id).replaceAll("\"", "'")}"]`);
		}
	}

	for (const channel of store.channels.values()) {
		const declared = declaredOn(channel);
		const label = (declared === undefined ? "UNDECLARED" : declared.type === "hub" ? "hub" : declared.type === "discovered" ? (declared.kind === "commands" ? "commands" : "store") : declared.spec.protocol) + (channel.medium === undefined ? "" : " via " + channel.medium) + " · " + formatCount(channel.count);

		lines.push(`  ${id(channel.a)} ${declared?.type === "hub" ? "<==>" : "<-->"}|${label}| ${id(channel.b)}`);
	}

	return lines.join("\n");
}

// ── the view ──────────────────────────────────────────────────────────────────────────────────────────────────

type Selection = { "type": "node"; "id": string } | { "type": "edge"; "id": string } | undefined;
type Tab = "inspector" | "conformance" | "flows" | "log";

/** The words a channel's label or a node's id is made of, as a feature lens reads them: a subject's tokens, a command's
 *  (`cmd editor.annotations.resolve`), a store's path segments (`store:.silo/evidence/…`). */
function wordsOf(text: string): string[] {
	return text.replace(/^store:(.*?)(?:\.\w+)?$/u, "$1").replace(/^(?:cmd |↩ )/u, "").replaceAll("()", "").replaceAll(/<[^>]*>/gu, "").split(/[\s./·…*:]+/u).map((word) => word.replace(/^_+/u, "")).filter((word) => word.length > 2 && !word.startsWith("$"));
}

/** Words that say where a name lives, not what it's for: skipped to reach its feature. */
const CARRIERS = new Set(["editor", "silo", "vscode", "typescript", "tsserverRequest"]);

/** A label's feature: its subject's namespace (`evidence.observed` → evidence), a command's past `editor.`
 *  (`cmd editor.annotations.resolve` → annotations), a tsserver request's (`typescript.tsserverRequest _types.at` →
 *  types), a store's folder (`.silo/evidence/<user>/…` → evidence; a placeholder is no word). */
function featureOf(text: string): string | undefined {
	return wordsOf(text).find((word) => !CARRIERS.has(word));
}

/** What on a channel can name a feature: the subjects of its hub messages, the commands between extensions, and a store
 *  at either end — not a probe's labels (HTTP statuses, VS Code's own RPC). */
function featureTexts(channel: ChannelStats): string[] {
	const texts = [...channel.labels].flatMap(([label, stats]) => {
		if (label.startsWith("cmd ")) {
			return [label];
		}

		const subject = (stats.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;

		return subject === undefined || subject.startsWith("$") ? [] : [subject];
	});

	return [...texts, ...[channel.a, channel.b].filter((end) => end.startsWith("store:"))];
}

interface EdgeView {
	"id": string;
	"a": string;
	"b": string;
	"channel"?: ChannelStats;
	"type": "hub" | "channel" | "discovered" | "undeclared";
	"observed": boolean;
	"path": SVGPathElement;
	"label"?: SVGTextElement;
	"length": number;
	"inFlight": number;
}

interface Pulse { "element": SVGCircleElement; "edge": EdgeView; "forward": boolean; "start": number }

export function renderArchitectureView(root: HTMLElement, hub: Hub): { "dispose": () => void } {
	const store = architectureStore(hub);
	const disposables: (() => void)[] = [];
	let selection: Selection;
	let tab: Tab = "inspector";
	/** The feature the lens lights up (featureOf), or none. */
	let feature: string | undefined;
	let paused = false;
	let showAcks = false;
	let showDeclared = true;
	const collapsed = loadCollapsed();
	let zoom = 1;
	let autoFit = true;
	let logFilter = "";
	let hovered: string | undefined;

	root.classList.add("arch-root");
	root.replaceChildren(h("style", null, css));

	// ── toolbar
	const summary = h("span", { "class": "arch-summary" });
	// The feature lens: one feature lit, the rest faded — its features found in what's on the wire, refreshed as it opens.
	const featureSelect = h("select", { "class": "arch-select", "title": "Light up one feature — found in the subjects, commands and stores seen" });
	const refreshFeatures = (): void => {
		const counts = new Map<string, number>();

		for (const channel of store.channels.values()) {
			for (const text of featureTexts(channel)) {
				const found = featureOf(text);

				if (found !== undefined) {
					counts.set(found, (counts.get(found) ?? 0) + 1);
				}
			}
		}

		const features = [...counts.keys()].sort();

		featureSelect.replaceChildren(h("option", { "value": "" }, "All features"), ...features.map((name) => h("option", { "value": name, ...name === feature ? { "selected": "" } : {} }, name)));
	};

	refreshFeatures();
	featureSelect.addEventListener("focus", refreshFeatures);
	featureSelect.addEventListener("pointerdown", refreshFeatures);
	featureSelect.addEventListener("change", () => {
		feature = featureSelect.value === "" ? undefined : featureSelect.value;
		applySelection();
		refreshPanel();
	});
	const button = (label: string, title: string, onClick: (element: HTMLButtonElement) => void): HTMLButtonElement => {
		const element = h("button", { "class": "arch-button", "title": title }, label);

		element.addEventListener("click", () => { onClick(element); });

		return element;
	};

	const toggle = (label: string, title: string, initial: boolean, onChange: (value: boolean) => void): HTMLButtonElement => {
		const element = button(label, title, () => {
			const value = !element.classList.contains("checked");

			element.classList.toggle("checked", value);
			onChange(value);
		});

		element.classList.toggle("checked", initial);

		return element;
	};

	const copy = (element: HTMLButtonElement, text: string): void => {
		const label = element.textContent;

		void navigator.clipboard.writeText(text).then(() => {
			element.textContent = "Copied";
			setTimeout(() => { element.textContent = label; }, 1500);
		});
	};

	root.append(h(
		"div",
		{ "class": "arch-toolbar" },
		h("span", { "class": "arch-title" }, "Live architecture"),
		summary,
		h("span", { "class": "arch-legend" }, ...KINDS.map((kind) => h("span", { "class": "arch-chip k-" + kind }, kind))),
		h("span", { "class": "arch-spacer" }),
		toggle("Pause", "Pause the animation and the log", paused, (value) => {
			paused = value;

			if (paused) {
				clearPulses();
			}
		}),
		toggle("Acks", "Show RPC acknowledgements", showAcks, (value) => { showAcks = value; refreshPanel(); }),
		toggle("Payloads", "Capture what each message carries, everywhere (it records the app's data) — shown in a channel's recent traffic", capturing, (value) => {
			capturing = value;
			requestArchSync(hub, { "capture": value });
		}),
		toggle("Idle", "Show declared contexts that aren't running", showDeclared, (value) => { showDeclared = value; scheduleRender(); }),
		featureSelect,
		button("−", "Zoom out", () => { setZoom(zoom / 1.2); }),
		button("Fit", "Fit the width", () => { autoFit = true; fit(); }),
		button("+", "Zoom in", () => { setZoom(zoom * 1.2); }),
		button("Reset", "Reset the counters", () => { store.resetCounters(); refreshPanel(); }),
		button("Mermaid", "Copy the OBSERVED architecture as a Mermaid flowchart", (element) => { copy(element, observedMermaid(store)); }),
		button("Model", "Copy the DECLARED model as a Mermaid flowchart (for ARCHITECTURE.md)", (element) => { copy(element, declaredMermaid()); }),
		button("Export", "Download a JSON snapshot of everything recorded", () => {
			const url = URL.createObjectURL(new Blob([JSON.stringify(store.snapshot(), null, 2)], { "type": "application/json" }));
			const link = h("a", { "href": url, "download": "architecture-" + new Date().toISOString().replaceAll(/[:.]/gu, "-") + ".json" });

			link.click();
			URL.revokeObjectURL(url);
		})
	));

	// ── canvas + side panel
	const svg = s("svg", { "class": "arch-svg" });
	const containerLayer = s("g");
	const edgeLayer = s("g");
	const nodeLayer = s("g");
	const pulseLayer = s("g", { "class": "arch-pulses" });

	svg.append(containerLayer, edgeLayer, nodeLayer, pulseLayer);

	const canvas = h("div", { "class": "arch-canvas" }, svg);
	const tabs = h("div", { "class": "arch-tabs" });
	const panel = h("div", { "class": "arch-panel" });

	root.append(h("div", { "class": "arch-body" }, canvas, h("div", { "class": "arch-side" }, tabs, panel)));

	svg.addEventListener("click", (event) => {
		if (event.target === svg) {
			select(undefined);
		}
	});
	canvas.addEventListener("wheel", (event) => {
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
		}
	}, { "passive": false });

	// The editor pane's scrollable element consumes wheel events: let ours scroll natively.
	const stopWheel = (event: WheelEvent): void => { event.stopPropagation(); };

	root.addEventListener("wheel", stopWheel, { "passive": true });
	disposables.push(() => { root.removeEventListener("wheel", stopWheel); });

	// ── diagram
	let layout: Layout | undefined;
	/** A previewed app's own contexts, and how they nest, as of the last render (see appLayout). */
	let appInfo: AppLayout = { "nodes": new Set(), "parent": new Map() };
	let app: ReadonlySet<string> = appInfo.nodes;
	let edges = new Map<string, EdgeView>();
	let edgesByNode = new Map<string, EdgeView[]>();
	const nodeElements = new Map<string, SVGGElement>();
	const lastActivity = new Map<string, number>();
	let renderScheduled = false;

	function scheduleRender(): void {
		if (!renderScheduled) {
			renderScheduled = true;
			requestAnimationFrame(() => {
				renderScheduled = false;
				render();
			});
		}
	}

	function applyZoom(): void {
		if (layout !== undefined) {
			svg.setAttribute("width", String(layout.width * zoom));
			svg.setAttribute("height", String(layout.height * zoom));
		}
	}

	function setZoom(value: number): void {
		autoFit = false;
		zoom = Math.min(3, Math.max(0.25, value));
		applyZoom();
	}

	function fit(): void {
		if (layout !== undefined && canvas.clientWidth > 0) {
			// Width only: the diagram is tall, scrolling vertically reads better.
			zoom = Math.min(1.25, Math.max(0.25, (canvas.clientWidth - 16) / layout.width));
			applyZoom();
		}
	}

	function addEdge(id: string, a: string, b: string, channel: ChannelStats | undefined): void {
		const from = layout.nodes.get(a);
		const to = layout.nodes.get(b);

		// Both ends inside one collapsed box: nothing to draw.
		if (from === undefined || to === undefined || from === to) {
			return;
		}

		const declared = channel === undefined ? declaredBetween(a, b) : declaredOn(channel);
		// A previewed app's own lines are its business, not undeclared editor traffic.
		const type = declared === undefined ? (app.has(a) || app.has(b) ? "channel" : "undeclared") : declared.type;
		const observed = channel !== undefined && (channel.count > 0 || channel.linked);
		const d = edgePath(from, to);
		const path = s("path", { "d": d, "class": `arch-edge type-${type} status-${type === "undeclared" ? "undeclared" : observed ? "declared" : "ghost"}` });
		const hit = s("path", { "d": d, "class": "arch-edge-hit" });
		const intoCollapsed = layout.hidden.has(a) || layout.hidden.has(b);
		// Into a collapsed box, a box's lines overlap: their numbers would too, so they go unlabelled.
		const group = s("g", { "data-edge": id, "class": intoCollapsed ? "into-collapsed" : undefined });
		let label: SVGTextElement | undefined;

		group.append(path, hit);

		if (observed) {
			const middle = path.getPointAtLength(path.getTotalLength() / 2);

			label = s("text", { "x": middle.x, "y": middle.y - 4, "class": "arch-edge-label" });
			group.append(label);
		}

		hit.addEventListener("click", (event) => {
			event.stopPropagation();
			select({ "type": "edge", "id": id });
		});
		hit.addEventListener("mouseenter", () => { group.classList.add("hover"); });
		hit.addEventListener("mouseleave", () => { group.classList.remove("hover"); });
		edgeLayer.append(group);

		const view: EdgeView = { "id": id, "a": a, "b": b, "channel": channel, "type": type, "observed": observed, "path": path, "label": label, "length": path.getTotalLength(), "inFlight": 0 };

		edges.set(id, view);

		// A collapsed box's header highlights its nodes' lines: they're filed under the box too.
		for (const end of [a, b, ...[a, b].map((node) => layout.hidden.get(node)).filter((box) => box !== undefined).map((box) => "box:" + box)]) {
			edgesByNode.set(end, [...edgesByNode.get(end) ?? [], view]);
		}
	}

	function render(): void {
		const now = Date.now();
		// A medium only two contexts use is drawn as the edge between them (its channel's `medium`), not as a box.
		const media = store.media();
		const visible = [...store.nodes.values()].filter((node) => !media.has(node.id) && isVisible(node, now, showDeclared));

		// Declared nodes nobody reported yet are drawn idle.
		if (showDeclared) {
			for (const declared of declaredNodes) {
				if (!store.nodes.has(declared.id) && !media.has(declared.id)) {
					visible.push({ "id": declared.id, "spec": { "id": declared.id }, "state": "declared", "instances": 0, "spawnCount": 0, "reporters": new Set() });
				}
			}
		}

		appInfo = appLayout({ "channels": [...store.channels.values()], "topology": store.topology, "realms": store.realms });
		app = appInfo.nodes;

		const drawn = visible;
		const visibleIds = new Set(drawn.map((node) => node.id));

		layout = computeLayout(drawn, collapsed, appInfo);
		svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
		applyZoom();
		clearPulses();

		containerLayer.replaceChildren();

		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (rect !== undefined) {
				const standsFor = container.node !== undefined && visibleIds.has(container.node) ? visible.find((node) => node.id === container.node) : undefined;
				// A box that stands for a node carries that node's status dot (and hub size) before its label.
				const nodeClasses = standsFor === undefined ? "" : ` is-node state-${standsFor.state}${nodeSpec(standsFor.id)?.hub === true ? " is-hub" : ""}`;
				const group = s("g", { "class": "arch-container kind-" + (container.kind === "process" ? "remote" : container.kind) + nodeClasses, "data-node": standsFor?.id });
				// Standing for a node, the header lays out like that node's box: dot, label, then the caption as its detail line.
				const text = standsFor === undefined ? { "x": rect.x + 10, "label": rect.y + 15, "caption": rect.y + 27 } : { "x": rect.x + 22, "label": rect.y + 19, "caption": rect.y + 34 };
				const collapsible = container.collapsed !== undefined;

				// A collapsible box's chevron sits where a node's dot would.
				if (collapsible) {
					text.x = rect.x + 22;
				}

				group.append(
					s("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height, "rx": 8 }),
					s("text", { "x": text.x, "y": text.label, "class": "arch-container-label" }, container.label),
					// Standing for a node, the line beneath is that node's detail, as on a node's box (the caption is in the Inspector).
					s("text", { "x": text.x, "y": text.caption, "class": "arch-container-caption" }, standsFor === undefined ? container.caption : detailOf(standsFor))
				);

				if (standsFor !== undefined) {
					group.append(s("circle", { "cx": rect.x + 11, "cy": rect.y + 15, "r": 4, "class": "arch-node-dot" }));
				}

				if (collapsible) {
					const isCollapsed = collapsed.has(container.id);

					group.classList.toggle("is-collapsed", isCollapsed);
					group.append(s("path", { "d": isCollapsed ? `M ${rect.x + 9} ${rect.y + 8} l 4 4 l -4 4` : `M ${rect.x + 7} ${rect.y + 10} l 4 4 l 4 -4`, "class": "arch-container-chevron" }));

					if (isCollapsed) {
						const count = [...layout.hidden.values()].filter((box) => box === container.id).length;

						group.append(s("text", { "x": rect.x + rect.width - 8, "y": rect.y + 15, "class": "arch-node-badge", "text-anchor": "end" }, count === 0 ? "" : String(count)));
					}
				}

				containerLayer.append(group);
			}
		}

		edgeLayer.replaceChildren();
		edges = new Map();
		edgesByNode = new Map();

		// One line per pair of ends, whichever side reported it.
		const drawnPairs = new Set<string>();

		for (const channel of store.channels.values()) {
			const { a, b } = channel;
			const pair = [a, b].sort().join("|");

			if (a !== b && visibleIds.has(a) && visibleIds.has(b) && !drawnPairs.has(pair)) {
				drawnPairs.add(pair);
				addEdge(channel.id, a, b, channel);
			}
		}

		// Declared but not observed: the hub tree, then fixed-endpoint channels.
		const present = (a: string, b: string): boolean => store.between(a, b) !== undefined || media.get(a)?.includes(b) === true || media.get(b)?.includes(a) === true;

		for (const [a, b] of hubLinks) {
			if (!present(a, b) && visibleIds.has(a) && visibleIds.has(b)) {
				addEdge("declared:" + a + "|" + b, a, b, undefined);
			}
		}

		for (const channel of declaredChannels) {
			if (!channel.a.includes("*") && !channel.b.includes("*") && !present(channel.a, channel.b) && visibleIds.has(channel.a) && visibleIds.has(channel.b)) {
				addEdge("declared:" + channel.a + "|" + channel.b, channel.a, channel.b, undefined);
			}
		}

		nodeLayer.replaceChildren();
		nodeElements.clear();

		for (const node of drawn) {
			if (drawnAsContainer.has(node.id) || layout.hidden.has(node.id)) {
				continue; // drawn as its container, or folded into a collapsed one (above)
			}

			const rect = layout.nodes.get(node.id);
			const declared = nodeSpec(node.id);
			// Declared by id, created at runtime under a prefix the model declares (preview:, vite:, worker: …), or the
			// previewed app's own.
			const known = declared !== undefined || DYNAMIC_PREFIXES.some((prefix) => node.id.startsWith(prefix)) || app.has(node.id);
			const group = s("g", { "class": `arch-node state-${node.state}${declared?.hub === true ? " is-hub" : ""}`, "data-node": node.id });

			group.append(
				s("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height, "rx": 6, "class": known ? undefined : "undeclared" }),
				s("circle", { "cx": rect.x + 11, "cy": rect.y + 15, "r": 4, "class": "arch-node-dot" }),
				s("text", { "x": rect.x + 22, "y": rect.y + 19, "class": "arch-node-label" }, labelOf(store, node.id)),
				s("text", { "x": rect.x + 22, "y": rect.y + 34, "class": "arch-node-detail" }, detailOf(node)),
				s("text", { "x": rect.x + rect.width - 8, "y": rect.y + 19, "class": "arch-node-badge", "text-anchor": "end" })
			);
			group.addEventListener("click", (event) => {
				event.stopPropagation();
				select({ "type": "node", "id": node.id });
			});
			group.addEventListener("mouseenter", () => { setHovered(node.id); });
			group.addEventListener("mouseleave", () => { setHovered(undefined); });
			nodeLayer.append(group);
			nodeElements.set(node.id, group);
		}

		// A box that stands for a node: its header selects and highlights that node, like the node's own box would. On the
		// node layer — above the lines, which all end at that header.
		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (container.node === undefined || rect === undefined || !visibleIds.has(container.node)) {
				continue;
			}

			const standsFor = container.node;
			const header = s("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": headerOf(container), "rx": 8, "class": "arch-container-hit", "data-node": standsFor });

			header.addEventListener("click", (event) => {
				event.stopPropagation();
				select({ "type": "node", "id": standsFor });
			});
			header.addEventListener("mouseenter", () => { setHovered(standsFor); });
			header.addEventListener("mouseleave", () => { setHovered(undefined); });
			nodeLayer.append(header);
		}

		// A collapsible box's header opens and closes it; hovering it highlights its nodes' lines.
		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (container.collapsed === undefined || rect === undefined) {
				continue;
			}

			const header = s("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": HEADER, "rx": 8, "class": "arch-container-hit" });
			const box = "box:" + container.id;

			header.append(s("title", {}, collapsed.has(container.id) ? "Expand" : "Collapse"));
			header.addEventListener("click", (event) => {
				event.stopPropagation();

				if (!collapsed.delete(container.id)) {
					collapsed.add(container.id);
				}

				saveCollapsed(collapsed);
				setHovered(undefined);
				scheduleRender();
			});
			header.addEventListener("mouseenter", () => { setHovered(box); });
			header.addEventListener("mouseleave", () => { setHovered(undefined); });
			nodeLayer.append(header);
		}

		applySelection();
		tick();

		if (autoFit) {
			fit();
		}
	}

	function setHovered(id: string | undefined): void {
		hovered = id;
		applySelection();
	}

	function applySelection(): void {
		const focusNode = hovered ?? (selection?.type === "node" ? selection.id : undefined);
		const focusEdge = selection?.type === "edge" ? edges.get(selection.id) : undefined;

		// The feature lens, when nothing's hovered or picked: its edges, and the contexts at their ends.
		if (feature !== undefined && focusNode === undefined && focusEdge === undefined) {
			const lit = [...edges.values()].filter((edge) => edge.channel !== undefined && featureTexts(edge.channel).some((text) => wordsOf(text).includes(feature!)));
			const ends = new Set(lit.flatMap((edge) => [edge.a, edge.b]));

			svg.classList.add("has-focus");

			for (const [id, element] of nodeElements) {
				element.classList.toggle("focus", ends.has(id));
				element.classList.remove("selected");
			}

			for (const edge of edges.values()) {
				edge.path.parentElement.classList.toggle("focus", lit.includes(edge));
				edge.path.parentElement.classList.remove("selected");
			}

			return;
		}

		svg.classList.toggle("has-focus", focusNode !== undefined || focusEdge !== undefined);

		for (const [id, element] of nodeElements) {
			element.classList.toggle("focus", id === focusNode || id === focusEdge?.a || id === focusEdge?.b);
			element.classList.toggle("selected", selection?.type === "node" && selection.id === id);
		}

		const around = new Set(focusNode === undefined ? [] : edgesByNode.get(focusNode) ?? []);

		for (const edge of edges.values()) {
			const group = edge.path.parentElement;

			group.classList.toggle("focus", around.has(edge) || edge === focusEdge);
			group.classList.toggle("selected", edge === focusEdge);
		}
	}

	/** Refresh the numbers (every tick): edge widths and labels, node activity and badges, the summary. */
	function tick(): void {
		const now = Date.now();
		let total = 0;

		for (const edge of edges.values()) {
			if (edge.channel === undefined) {
				continue;
			}

			const rate = store.rate(edge.channel, now);

			total += rate;
			// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: the width follows the live rate (a stroke-width attribute would lose to the stylesheet)
			edge.path.style.strokeWidth = String((edge.type === "hub" ? 2.5 : 1.5) + Math.min(4, Math.log2(1 + rate)));

			if (edge.label !== undefined) {
				edge.label.textContent = edge.channel.count > 0 ? formatCount(edge.channel.count) + (rate > 0 ? " · " + formatRate(rate) : "") : "linked";
			}
		}

		for (const [id, element] of nodeElements) {
			const node = store.nodes.get(id);

			element.classList.toggle("active", now - (lastActivity.get(id) ?? -Infinity) < 600);

			const badge = element.querySelector(".arch-node-badge");

			if (badge !== null && node !== undefined) {
				badge.textContent = node.instances > 1 ? "×" + node.instances : node.spawnCount > 1 ? node.spawnCount + " starts" : "";
			}
		}

		const alive = [...store.nodes.values()].filter((node) => node.state === "alive").length;
		const violations = conformance().length;

		summary.replaceChildren(
			`${alive} contexts · ${store.channels.size} channels · ${store.reporters.size} reporters · ${formatRate(total)}`,
			violations > 0 ? h("span", { "class": "arch-violations" }, ` · ${violations} to review`) : ""
		);
	}

	// ── pulses
	let pulses: Pulse[] = [];
	let frame: number | undefined;

	function clearPulses(): void {
		for (const pulse of pulses) {
			pulse.element.remove();
		}

		pulses = [];

		for (const edge of edges.values()) {
			edge.inFlight = 0;
		}
	}

	function onSample(sample: StoredSample, channel: ChannelStats): void {
		const now = Date.now();

		lastActivity.set(channel.a, now);
		lastActivity.set(channel.b, now);

		const edge = edges.get(channel.id);

		if (paused || edge === undefined || (sample.kind === "ack" && !showAcks) || edge.inFlight >= MAX_PULSES_PER_EDGE || pulses.length >= MAX_PULSES || document.hidden) {
			return;
		}

		const element = s("circle", { "r": 3.5, "class": "arch-pulse k-" + sample.kind });

		pulseLayer.append(element);
		// Samples arrive batched (every 250ms): stagger them back to their real spacing.
		pulses.push({ "element": element, "edge": edge, "forward": sample.forward, "start": performance.now() + Math.max(0, Math.min(400, sample.t - now + 300)) });
		edge.inFlight += 1;
		frame ??= requestAnimationFrame(animate);
	}

	function animate(now: number): void {
		frame = undefined;
		pulses = pulses.filter((pulse) => {
			const progress = (now - pulse.start) / PULSE_DURATION_MS;

			if (progress >= 1) {
				pulse.element.remove();
				pulse.edge.inFlight -= 1;

				return false;
			}

			const point = pulse.edge.path.getPointAtLength((pulse.forward ? Math.max(0, progress) : 1 - Math.max(0, progress)) * pulse.edge.length);

			pulse.element.setAttribute("cx", String(point.x));
			pulse.element.setAttribute("cy", String(point.y));
			pulse.element.setAttribute("opacity", progress < 0 ? "0" : "1");

			return true;
		});

		if (pulses.length > 0) {
			frame = requestAnimationFrame(animate);
		}
	}

	// ── side panel
	function conformance(): Violation[] {
		return conformanceOf(store);
	}

	function select(value: Selection): void {
		selection = value;

		if (value !== undefined) {
			tab = "inspector";
		}

		applySelection();
		refreshPanel(true);
	}

	function link(label: string, target: Selection, className = "arch-link"): HTMLAnchorElement {
		const element = h("a", { "class": className, "href": "#" }, label);

		element.addEventListener("click", (event) => {
			event.preventDefault();
			select(target);
		});

		return element;
	}

	const section = (title: string, ...content: Child[]): HTMLElement => h("section", { "class": "arch-section" }, h("h3", null, title), ...content);
	const keyValues = (entries: [string, Node | string | undefined][]): HTMLElement => h("dl", { "class": "arch-kv" }, ...entries.filter(([, value]) => value !== undefined && value !== "").flatMap(([key, value]) => [h("dt", null, key), h("dd", null, value)]));
	const table = (headers: string[], rows: Child[][]): HTMLElement => h("table", { "class": "arch-table" }, h("tr", null, ...headers.map((header) => h("th", null, header))), ...rows.map((row) => h("tr", null, ...row.map((cell) => h("td", null, cell)))));

	function sampleRow(sample: StoredSample, channel: ChannelStats | undefined, withEndpoints: boolean): HTMLElement {
		const from = channel === undefined ? "" : sample.forward ? channel.a : channel.b;
		const to = channel === undefined ? "" : sample.forward ? channel.b : channel.a;
		const row = h(
			"div",
			{ "class": "arch-event" },
			h("span", { "class": "arch-event-time" }, formatTime(sample.t)),
			h("span", { "class": "arch-chip k-" + sample.kind }, sample.kind),
			withEndpoints ? h("span", { "class": "arch-event-endpoints" }, labelOf(store, from) + " → " + labelOf(store, to)) : h("span", { "class": "arch-event-direction" }, sample.forward ? "→" : "←"),
			h("span", { "class": "arch-event-label", "title": sample.label }, sample.label),
			h("span", { "class": "arch-event-bytes" }, sample.bytes > 0 ? formatBytes(sample.bytes) : "")
		);

		// What it carried, when payload capture was on.
		if (sample.payload !== undefined) {
			row.append(h("pre", { "class": "arch-event-payload" }, sample.payload));
		}

		if (channel !== undefined && withEndpoints) {
			row.addEventListener("click", () => { select({ "type": "edge", "id": channel.id }); });
		}

		return row;
	}

	function renderOverview(): Child[] {
		const now = Date.now();
		const busiest = [...store.channels.values()].sort((a, b) => b.count - a.count).slice(0, 12);

		return [
			section(
				"How to read it",
				h("p", null, "Boxes are where code runs: realms (windows, workers) and origins (iframes). Solid double lines are hub links — the tree every context's hub federates over; thin lines are channels the probes observe outside the hubs (workers, extension hosts, network). Dots are messages."),
				h("p", null, "Dashed means declared in the model (", h("code", null, "packages/vscode/architecture-model.ts"), ") but not seen yet; red means seen but not declared — fix the model or the code. Green lines were discovered, not declared: an extension's commands, and what's written to a store and read from it."),
				h("p", null, "Click a context or a line to inspect it. Pick a feature beside Idle to light only its part.")
			),
			section("Busiest channels", table(["Channel", "Messages", "Rate"], busiest.map((channel) => [
				link(labelOf(store, channel.a) + " ⇄ " + labelOf(store, channel.b), { "type": "edge", "id": channel.id }),
				formatCount(channel.count),
				formatRate(store.rate(channel, now))
			])))
		];
	}

	function renderNode(id: string): Child[] {
		const node = store.nodes.get(id);
		const declared = nodeSpec(id);
		const container = containers.find((candidate) => candidate.id === (node === undefined ? declared?.container : containerOf(node, app)));
		const now = Date.now();
		const channels = [...store.channels.values()].filter((channel) => channel.a === id || channel.b === id).sort((a, b) => b.count - a.count);
		const topology = store.topology.get(id);

		return [
			h("h2", null, labelOf(store, id)),
			h("div", { "class": "arch-state state-" + (node?.state ?? "declared") }, node?.state ?? "not seen yet"),
			section(
				"Context",
				keyValues([
					["Id", id],
					["Runs in", container === undefined ? undefined : container.label + " — " + container.caption],
					["Detail", declared?.detail ?? node?.spec.detail],
					["Only", declared?.condition],
					["Instances", node !== undefined && node.instances > 0 ? String(node.instances) : undefined],
					["Started", node !== undefined && node.spawnCount > 1 ? node.spawnCount + " times" : undefined],
					["First seen", node?.createdAt === undefined ? undefined : formatTime(node.createdAt)],
					["Ended", node?.endedAt === undefined ? undefined : formatTime(node.endedAt)],
					["Reported by", node === undefined ? undefined : [...node.reporters].join(", ")],
					...Object.entries(node?.spec.meta ?? {}).map(([key, value]): [string, string] => [key, value])
				]),
				h("p", null, declared?.description ?? ""),
				declared === undefined ? undeclaredNote(id, app) : h("p", { "class": "arch-muted" }, "Observed by: " + declared.observedBy)
			),
			// What's inside it, discovered: its subscriptions grouped by the function that registered them (DISCOVERED-ARCHITECTURE.md).
			topology !== undefined && section(
				"Components",
				h("p", { "class": "arch-muted" }, "What subscribed to this hub, by the function that registered it (or, where no name survived the build, by namespace)."),
				...componentsOf(topology).map(({ component, subjects }) => h("div", { "class": "arch-component" }, h("div", { "class": "arch-component-name" }, component), h("div", { "class": "arch-subjects" }, ...subjects.map((subject) => h("span", { "class": "arch-subject" }, subject)))))
			),
			topology !== undefined && section(
				"Hub",
				keyValues([["Subscriptions", topology.subscriptions.length === 0 ? "none" : String(topology.subscriptions.length)]]),
				h("div", { "class": "arch-subjects" }, ...topology.subscriptions.map((subject) => h("span", { "class": "arch-subject" }, subject))),
				table(["Link", "Peer"], topology.links.map((entry) => [entry.id, entry.peerId === undefined ? "anonymous" : link(labelOf(store, entry.peerId), { "type": "node", "id": entry.peerId })]))
			),
			section("Channels", channels.length === 0 ? h("p", { "class": "arch-muted" }, "No traffic observed yet.") : table(["With", "Messages", "Bytes", "Rate"], channels.map((channel) => [
				h("span", null, link(labelOf(store, channel.a === id ? channel.b : channel.a), { "type": "edge", "id": channel.id }), declaredOn(channel) === undefined ? h("span", { "class": "arch-violations" }, " undeclared") : null),
				formatCount(channel.count),
				formatBytes(channel.bytes),
				formatRate(store.rate(channel, now))
			])))
		];
	}

	function renderEdge(id: string): Child[] {
		const edge = edges.get(id);
		const channel = edge?.channel ?? store.channelById(id);
		const a = edge?.a ?? channel?.a;
		const b = edge?.b ?? channel?.b;

		if (a === undefined || b === undefined) {
			return [h("p", null, "This channel is gone.")];
		}

		const declared = channel === undefined ? declaredBetween(a, b) : declaredOn(channel);
		const families = declared?.type === "hub" ? familiesOnLink(a, b) : [];
		const header: Child[] = [
			h("h2", null, link(labelOf(store, a), { "type": "node", "id": a }), " ⇄ ", link(labelOf(store, b), { "type": "node", "id": b })),
			channel?.medium !== undefined && h("p", { "class": "arch-muted" }, "Through ", h("code", null, labelOf(store, channel.medium)), ` (${store.nodes.get(channel.medium)?.spec.detail ?? "a channel"}) — only these two use it.`),
			declared === undefined && (app.has(a) || app.has(b))
				? h("div", { "class": "arch-state state-alive" }, "the previewed app's own — not in the editor's model")
				: declared === undefined
				? h("div", { "class": "arch-state state-unresponsive" }, "undeclared: neither a hub link nor a channel in the model")
				: h("div", { "class": "arch-state " + (channel === undefined ? "state-declared" : "state-alive") }, (declared.type === "hub" ? "hub link" : declared.type === "discovered" ? (declared.kind === "commands" ? "discovered: extensions' commands (VS Code's command surface)" : "discovered: a store, by what's written to it and read from it") : "declared channel") + (channel === undefined ? ", not seen yet" : "")),
			declared?.type === "channel" && section(declared.spec.protocol, keyValues([["Transport", declared.spec.transport], ["Not a hub link because", declared.spec.reason]]), h("p", null, declared.spec.description)),
			declared?.type === "hub" && section(
				"Subjects allowed across this link",
				h("p", { "class": "arch-muted" }, "Each the way its events and calls go: → toward ", h("code", null, labelOf(store, b)), ", ← toward ", h("code", null, labelOf(store, a)), "."),
				h("div", { "class": "arch-subjects" }, ...families.map((family) => h("span", { "class": "arch-subject", "title": `${family.description}\nfrom ${family.from.join(", ") || "nobody"} to ${family.to.join(", ") || "nobody"}` }, `${directionOnLink(family, a, b) ?? ""} ${family.pattern}`)))
			)
		];

		if (channel === undefined) {
			return header;
		}

		const unexpected = (label: string): boolean => {
			// Only hub-carried messages are subjects; a probe-observed message on the same pair isn't. Each is checked the
			// way it went.
			const stats = channel.labels.get(label);

			if (declared?.type !== "hub" || stats === undefined || (stats.hub ?? 0) === 0 || subjectOfLabel(label) === undefined) {
				return false;
			}

			return (stats.forward > 0 && !allowedOnLink(label, a, b)) || (stats.backward > 0 && !allowedOnLink(label, b, a));
		};

		const labels = [...channel.labels.entries()].filter(([label]) => showAcks || !label.startsWith("ack ")).sort(([, x], [, y]) => y.count - x.count);
		const recent = channel.recent.filter((sample) => showAcks || sample.kind !== "ack").slice(-80).reverse();

		return [
			...header,
			Object.keys(channel.interest).length > 0 && section(
				"Interest",
				...Object.entries(channel.interest).map(([hubId, interest]) => h(
					"div",
					null,
					h("p", { "class": "arch-muted" }, labelOf(store, hubId === a ? b : a) + " asked " + labelOf(store, hubId) + " for:"),
					h("div", { "class": "arch-subjects" }, ...interest.map((subject) => h("span", { "class": "arch-subject" }, subject)))
				))
			),
			section(
				"Traffic",
				keyValues([
					["Messages", `${formatCount(channel.count)} (→ ${formatCount(channel.forward)} · ← ${formatCount(channel.backward)})`],
					["Rate", formatRate(store.rate(channel))],
					["Bytes", formatBytes(channel.bytes)],
					["Errors", channel.errors > 0 ? String(channel.errors) : undefined],
					["Last", channel.count > 0 ? formatTime(channel.lastAt) : undefined]
				]),
				h("p", { "class": "arch-muted" }, "→ is " + labelOf(store, channel.a) + " to " + labelOf(store, channel.b))
			),
			section(`Messages (${labels.length} distinct)`, table(["Message", "→", "←", "Bytes"], labels.slice(0, 50).map(([label, stats]) => [
				h("span", { "class": "arch-mono" + (unexpected(label) ? " arch-violations" : ""), "title": unexpected(label) ? "not allowed across this link by the model" : label }, label),
				formatCount(stats.forward),
				formatCount(stats.backward),
				formatBytes(stats.bytes)
			]))),
			section("Recent", ...recent.map((sample) => sampleRow(sample, channel, false)))
		];
	}

	function describeViolation(violation: Violation): Child {
		switch (violation.type) {
			case "undeclared-channel":
				return h("span", null, link(labelOf(store, violation.a) + " ⇄ " + labelOf(store, violation.b), { "type": "edge", "id": store.between(violation.a, violation.b)?.id ?? violation.a + "|" + violation.b }, "arch-link arch-violations"), " — no hub link or channel in the model");
			case "unexpected-subject":
				return h("span", null, h("code", null, violation.subject), ` × ${formatCount(violation.count)} across `, link(labelOf(store, violation.a) + " ⇄ " + labelOf(store, violation.b), { "type": "edge", "id": store.between(violation.a, violation.b)?.id ?? violation.a + "|" + violation.b }), " — not among the hubs of any family that may cross it");
			case "duplicate-peer":
				return h("span", null, link(labelOf(store, violation.hub), { "type": "node", "id": violation.hub }), ` has ${violation.links} links to "${violation.peer}" — duplicate hub ids, or stale links`);
			case "undeclared-store":
				return h("span", null, "IndexedDB ", h("code", null, violation.database), " (", link(labelOf(store, violation.by), { "type": "node", "id": violation.by }), ") — not among the model's stores");
			case "unknown-node":
			default:
				return h("span", null, link(labelOf(store, violation.id), { "type": "node", "id": violation.id }, "arch-link arch-violations"), " — not in the model");
		}
	}

	function renderConformance(): Child[] {
		const violations = conformance();
		const observed = [...store.channels.values()].filter((channel) => channel.count > 0 || channel.linked);
		const seen = (a: string, b: string): boolean => observed.some((channel) => (channel.a === a && channel.b === b) || (channel.a === b && channel.b === a));
		const seenByChannel = seenChannels(observed);

		return [
			section(
				"Summary",
				keyValues([
					["Hub links", `${hubLinks.filter(([a, b]) => seen(a, b)).length} / ${hubLinks.length} seen`],
					["Channels", `${declaredChannels.filter((channel) => seenByChannel.has(channel)).length} / ${declaredChannels.length} seen`],
					["To review", String(violations.length)]
				]),
				h("p", { "class": "arch-muted" }, "The model: packages/vscode/architecture-model.ts. Change it with the architecture.")
			),
			section("To review", violations.length === 0 ? h("p", { "class": "arch-muted" }, "Nothing — everything observed matches the model.") : h("ul", { "class": "arch-list" }, ...violations.map((violation) => h("li", null, describeViolation(violation))))),
			section("Hub links", table(["Link", "Messages"], hubLinks.map(([a, b]) => {
				const channel = observed.find((candidate) => (candidate.a === a && candidate.b === b) || (candidate.a === b && candidate.b === a));

				return [channel === undefined ? `${a} ⇄ ${b}` : link(`${a} ⇄ ${b}`, { "type": "edge", "id": channel.id }), channel === undefined ? "not seen" + (nodeSpec(b)?.condition === undefined ? "" : ` (${nodeSpec(b).condition})`) : formatCount(channel.count)];
			}))),
			section("Channels", table(["Channel", "Protocol", "Seen"], declaredChannels.map((channel) => [
				`${channel.a} ⇄ ${channel.b}`,
				channel.protocol,
				String(seenByChannel.get(channel) ?? "no")
			]))),
			...untouched(observed)
		];
	}

	/** The gaps the other way: the rules (subject families) and the discovered components no traffic touched this session
	 *  — untested paths, or ones this session never took (DISCOVERED-ARCHITECTURE.md). */
	function untouched(observed: ChannelStats[]): Child[] {
		const seenSubjects = new Set(observed.flatMap((channel) => [...channel.labels].flatMap(([label, stats]) => {
			const subject = (stats.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;

			return subject === undefined ? [] : [subject];
		})));
		// The reports themselves (`$sys.arch.*`) aren't counted — the reporter would be reporting its reports — but this
		// view has them, so they ran.
		const touched = (pattern: string): boolean => pattern.startsWith("$sys.arch.") || [...seenSubjects].some((subject) => subjectMatches(pattern, subject));
		const rules = subjectFamilies.filter((family) => !touched(family.pattern));
		const components = [...store.topology].flatMap(([hub, topology]) => componentsOf(topology).filter(({ subjects }) => !subjects.some((subject) => touched(subject.replace(/\(\)$/u, "")))).map(({ component, subjects }) => ({ "hub": hub, "component": component, "subjects": subjects })));

		return [
			section("Rules no traffic touched", rules.length === 0 ? h("p", { "class": "arch-muted" }, "Every subject family was seen this session.") : table(["Subject", "From → to"], rules.map((family) => [family.pattern, `${family.from.join(", ")} → ${family.to.join(", ")}`]))),
			section("Components no traffic touched", components.length === 0 ? h("p", { "class": "arch-muted" }, "Every discovered component heard something this session.") : table(["Component", "Of", "Serves and hears"], components.map(({ hub, component, subjects }) => [component, labelOf(store, hub), subjects.join(", ")])))
		];
	}

	const filterInput = h("input", { "class": "arch-input", "placeholder": "Filter (context, message…)", "type": "search" });
	const logList = h("div", { "class": "arch-log" });

	filterInput.addEventListener("input", () => {
		logFilter = filterInput.value.toLowerCase();
		refreshPanel();
	});

	/** The flows in the recent traffic (observability's flowsOf): each message, and what it caused, across hubs —
	 *  only those with more than one message, the newest first, and only the lens's feature's when one is lit. */
	function renderFlows(): Child[] {
		const samples = store.log.flatMap((sample) => {
			const channel = store.channelById(sample.channel);

			return channel === undefined ? [] : [{ ...sample, "from": sample.forward ? channel.a : channel.b, "to": sample.forward ? channel.b : channel.a }];
		});
		const everything = (message: FlowMessage): FlowMessage[] => [message, ...message.caused.flatMap(everything)];
		// A flow's shape: what it is and what it caused, whatever its ids — so a flow that keeps happening reads once, ×N.
		const shape = (message: FlowMessage): string => `${message.inferred === true ? "~" : ""}${message.label}[${message.path.join(">")}](${message.caused.map(shape).join(",")})`;
		const grouped = <T extends FlowMessage>(messages: T[]): { "message": T; "count": number }[] => {
			const groups = new Map<string, { "message": T; "count": number }>();

			for (const message of messages) {
				const known = groups.get(shape(message));

				groups.set(shape(message), { "message": message, "count": (known?.count ?? 0) + 1 });
			}

			return [...groups.values()];
		};
		// With no lens, flows of more than one message; with one, every message of its feature's.
		const flows = grouped(flowsOf(samples).filter((flow) => !flow.label.startsWith("$sys") && (feature === undefined ? flow.caused.length > 0 : everything(flow).some((message) => wordsOf(message.label).includes(feature!))))).reverse().slice(0, 40);
		const line = (message: FlowMessage, count: number, depth: number): HTMLElement[] => [
			h("div", { "class": "arch-flow" + (message.inferred === true ? " inferred" : ""), "style": `padding-left: ${depth * 14}px`, "title": message.inferred === true ? "linked by timing: its cause wasn't named" : "" }, h("span", { "class": "arch-flow-label" }, message.label), h("span", { "class": "arch-muted" }, " " + message.path.map((id) => labelOf(store, id)).join(" → ") + (count > 1 ? `  ×${count}` : ""))),
			...grouped(message.caused).flatMap((child) => line(child.message, child.count, depth + 1))
		];

		return flows.length === 0
			? [h("p", { "class": "arch-muted" }, feature === undefined ? "No flows yet: a flow is a message and the ones it caused, followed by the causes the hub names." : `No ${feature} messages in the recent traffic.`)]
			: [h("p", { "class": "arch-muted" }, "Each message and the ones it caused, across hubs, the same shape counted once (×N); dimmed lines are linked by timing, their cause not named."), ...flows.map(({ message, count }) => h("div", { "class": "arch-flow-group" }, ...line(message, count, 0)))];
	}

	function renderLog(): Child[] {
		const rows: HTMLElement[] = [];

		for (let index = store.log.length - 1; index >= 0 && rows.length < 300; index -= 1) {
			const sample = store.log[index];

			if (!showAcks && sample.kind === "ack") {
				continue;
			}

			const channel = store.channelById(sample.channel);

			if (logFilter.length > 0 && !`${sample.label} ${sample.kind} ${channel === undefined ? "" : labelOf(store, channel.a) + " " + labelOf(store, channel.b)}`.toLowerCase().includes(logFilter)) {
				continue;
			}

			rows.push(sampleRow(sample, channel, true));
		}

		logList.replaceChildren(...rows);

		return [filterInput, logList];
	}

	let panelHovered = false;

	panel.addEventListener("mouseenter", () => { panelHovered = true; });
	panel.addEventListener("mouseleave", () => { panelHovered = false; });

	// Created once — rebuilding them every tick would swallow clicks landing mid-rebuild.
	const tabButtons = new Map<Tab, HTMLButtonElement>((["inspector", "conformance", "flows", "log"] as Tab[]).map((id) => {
		const element = h("button", { "class": "arch-tab" });

		element.addEventListener("click", () => {
			tab = id;
			refreshPanel(true);
		});
		tabs.append(element);

		return [id, element];
	}));

	function refreshPanel(force = false): void {
		const violations = conformance().length;
		const labels: Record<Tab, string> = { "inspector": "Inspector", "conformance": violations > 0 ? `Conformance (${violations})` : "Conformance", "flows": "Flows", "log": "Log" };

		for (const [id, element] of tabButtons) {
			element.textContent = labels[id];
			element.classList.toggle("active", id === tab);
		}

		// Don't move content under the mouse unless asked.
		if (!force && (panelHovered || paused)) {
			return;
		}

		const { scrollTop } = panel;
		const content = tab === "conformance" ? renderConformance() : tab === "flows" ? renderFlows() : tab === "log" ? renderLog() : selection === undefined ? renderOverview() : selection.type === "node" ? renderNode(selection.id) : renderEdge(selection.id);

		panel.replaceChildren(...content.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
		panel.scrollTop = force ? 0 : scrollTop;
	}

	// ── wiring
	disposables.push(store.onTopologyChange(scheduleRender), store.onSample(onSample));

	const interval = setInterval(() => {
		const now = Date.now();

		store.sweep(now); // a reporter gone silent ends (re-rendering through the store's change)

		if ([...nodeElements.keys()].some((id) => {
			const node = store.nodes.get(id);

			return node !== undefined && !isVisible(node, now, showDeclared);
		})) {
			scheduleRender();
		}

		tick();
		refreshPanel();
	}, TICK_MS);
	const resizeObserver = new ResizeObserver(() => {
		if (autoFit) {
			fit();
		}
	});

	resizeObserver.observe(canvas);
	disposables.push(() => { clearInterval(interval); }, () => { resizeObserver.disconnect(); });

	render();
	refreshPanel(true);

	return {
		"dispose": () => {
			clearPulses();

			if (frame !== undefined) {
				cancelAnimationFrame(frame);
			}

			for (const dispose of disposables) {
				dispose();
			}

			root.replaceChildren();
		}
	};
}
