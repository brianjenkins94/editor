/**
 * The live architecture view (binding): draws the ArchitectureStore — fed by every context's `$sys.arch` reports
 * over the hub tree — against the declared model (architecture-model.ts). Boxes are realms/origins, nodes are
 * contexts, solid double lines are hub links, thin lines probed channels, dots the messages flowing. Declared but
 * idle channels are dashed; anything observed that the model doesn't declare is red.
 *
 * Plain DOM/SVG in the workbench realm (hosted by the component's editor pane), themed with VS Code's variables.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ChannelStats, RuntimeNode, StoredSample, TrafficKind } from "@brianjenkins94/observability";
import type { ContainerSpec, Violation } from "./architecture-model";
import { ArchitectureStore, collectArchReports, requestArchSync } from "@brianjenkins94/observability";
import { checkConformance, containers, declaredBetween, channels as declaredChannels, declaredMermaid, nodes as declaredNodes, familiesOnLink, hubLinks, nodeSpec, subjectMatches, subjectOfLabel } from "./architecture-model";
import css from "./architecture-view.css?raw";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_HEIGHT = 44;
const NODE_WIDTH = 210;
const GAP = 8;
const PADDING = 10;
const HEADER = 34;
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

/** The workbench's architecture store — created on first use: subscribes to every reporter and asks for a sync. */
export function architectureStore(hub: Hub): ArchitectureStore {
	if (shared === undefined) {
		const store = new ArchitectureStore();

		shared = store;
		collectArchReports(hub, (report) => { store.apply(report); });
		// The subscription's interest has to reach the other hubs before they're asked to answer.
		setTimeout(() => { requestArchSync(hub); }, 200);
	}

	return shared;
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

function containerOf(node: RuntimeNode): string {
	const declared = nodeSpec(node.id)?.container ?? node.spec.container;

	if (declared !== undefined && containers.some((container) => container.id === declared)) {
		return declared;
	}

	if (node.id.startsWith("net:")) {
		return "network";
	}

	// An anonymous hub peer (`<hub>:link-N` — a hub that didn't say who it is): next to the hub reporting it.
	const anonymous = /^(.+):link-\d+$/u.exec(node.id);

	if (anonymous !== null) {
		return nodeSpec(anonymous[1])?.container ?? "workbench";
	}

	return node.id.startsWith("worker:") ? "workers" : "workbench";
}

function labelOf(store: ArchitectureStore, id: string): string {
	return nodeSpec(id)?.label ?? store.nodes.get(id)?.spec.label ?? id;
}

function detailOf(node: RuntimeNode): string {
	return nodeSpec(node.id)?.detail ?? node.spec.detail ?? node.spec.role ?? "";
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
interface Layout { "width": number; "height": number; "nodes": Map<string, Rect>; "containers": Map<string, Rect> }

function computeLayout(visible: RuntimeNode[]): Layout {
	const order = new Map(declaredNodes.map((node, index) => [node.id, index]));
	const byContainer = new Map<string, RuntimeNode[]>();

	for (const node of visible) {
		const list = byContainer.get(containerOf(node)) ?? [];

		list.push(node);
		byContainer.set(containerOf(node), list);
	}

	for (const list of byContainer.values()) {
		list.sort((a, b) => ((order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)) || a.id.localeCompare(b.id));
	}

	const children = (container: ContainerSpec): ContainerSpec[] => containers.filter((candidate) => candidate.parent === container.id);
	const sizes = new Map<string, { "width": number; "height": number }>();
	const measure = (container: ContainerSpec): { "width": number; "height": number } => {
		const items = [
			...(byContainer.get(container.id) ?? []).map(() => ({ "width": NODE_WIDTH, "height": NODE_HEIGHT })),
			...children(container).map(measure)
		];
		const width = Math.max(NODE_WIDTH, ...items.map((item) => item.width));
		const height = HEADER + items.reduce((sum, item, index) => sum + item.height + (index > 0 ? GAP : 0), 0);
		const size = { "width": width + PADDING * 2, "height": height + PADDING };

		sizes.set(container.id, size);

		return size;
	};

	const layout: Layout = { "width": 0, "height": 0, "nodes": new Map(), "containers": new Map() };
	const place = (container: ContainerSpec, x: number, y: number, width: number): void => {
		layout.containers.set(container.id, { "x": x, "y": y, "width": width, "height": sizes.get(container.id).height });

		let cursor = y + HEADER;
		const inner = width - PADDING * 2;

		for (const node of byContainer.get(container.id) ?? []) {
			layout.nodes.set(node.id, { "x": x + PADDING, "y": cursor, "width": inner, "height": NODE_HEIGHT });
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
		if (node.state !== "declared") {
			lines.push(`  ${id(node.id)}["${labelOf(store, node.id).replaceAll("\"", "'")}"]`);
		}
	}

	for (const channel of store.channels.values()) {
		const declared = declaredBetween(channel.a, channel.b);
		const label = (declared === undefined ? "UNDECLARED" : declared.type === "hub" ? "hub" : declared.spec.protocol) + " · " + formatCount(channel.count);

		lines.push(`  ${id(channel.a)} ${declared?.type === "hub" ? "<==>" : "<-->"}|${label}| ${id(channel.b)}`);
	}

	return lines.join("\n");
}

// ── the view ──────────────────────────────────────────────────────────────────────────────────────────────────

type Selection = { "type": "node"; "id": string } | { "type": "edge"; "id": string } | undefined;
type Tab = "inspector" | "conformance" | "log";

interface EdgeView {
	"id": string;
	"a": string;
	"b": string;
	"channel"?: ChannelStats;
	"type": "hub" | "channel" | "undeclared";
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
	let paused = false;
	let showAcks = false;
	let showDeclared = true;
	let zoom = 1;
	let autoFit = true;
	let logFilter = "";
	let hovered: string | undefined;

	root.classList.add("arch-root");
	root.replaceChildren(h("style", null, css));

	// ── toolbar
	const summary = h("span", { "class": "arch-summary" });
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
		toggle("Idle", "Show declared contexts that aren't running", showDeclared, (value) => { showDeclared = value; scheduleRender(); }),
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

		if (from === undefined || to === undefined) {
			return;
		}

		const declared = declaredBetween(a, b);
		const type = declared === undefined ? "undeclared" : declared.type;
		const observed = channel !== undefined && (channel.count > 0 || channel.linked);
		const d = edgePath(from, to);
		const path = s("path", { "d": d, "class": `arch-edge type-${type} status-${type === "undeclared" ? "undeclared" : observed ? "declared" : "ghost"}` });
		const hit = s("path", { "d": d, "class": "arch-edge-hit" });
		const group = s("g", { "data-edge": id });
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

		for (const end of [a, b]) {
			edgesByNode.set(end, [...edgesByNode.get(end) ?? [], view]);
		}
	}

	function render(): void {
		const now = Date.now();
		const visible = [...store.nodes.values()].filter((node) => isVisible(node, now, showDeclared));

		// Declared nodes nobody reported yet are drawn idle.
		if (showDeclared) {
			for (const declared of declaredNodes) {
				if (!store.nodes.has(declared.id)) {
					visible.push({ "id": declared.id, "spec": { "id": declared.id }, "state": "declared", "instances": 0, "spawnCount": 0, "reporters": new Set() });
				}
			}
		}

		const visibleIds = new Set(visible.map((node) => node.id));

		layout = computeLayout(visible);
		svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
		applyZoom();
		clearPulses();

		containerLayer.replaceChildren();

		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (rect !== undefined) {
				const group = s("g", { "class": "arch-container kind-" + (container.kind === "process" ? "remote" : container.kind) });

				group.append(
					s("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height, "rx": 8 }),
					s("text", { "x": rect.x + 10, "y": rect.y + 15, "class": "arch-container-label" }, container.label),
					s("text", { "x": rect.x + 10, "y": rect.y + 27, "class": "arch-container-caption" }, container.caption)
				);
				containerLayer.append(group);
			}
		}

		edgeLayer.replaceChildren();
		edges = new Map();
		edgesByNode = new Map();

		for (const channel of store.channels.values()) {
			if (visibleIds.has(channel.a) && visibleIds.has(channel.b)) {
				addEdge(channel.id, channel.a, channel.b, channel);
			}
		}

		// Declared but not observed: the hub tree, then fixed-endpoint channels.
		const present = (a: string, b: string): boolean => store.channels.has(a + "|" + b) || store.channels.has(b + "|" + a);

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

		for (const node of visible) {
			const rect = layout.nodes.get(node.id);
			const declared = nodeSpec(node.id);
			const known = declared !== undefined || node.id.startsWith("webview:") || node.id.startsWith("nested:") || node.id.startsWith("worker:");
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
		return checkConformance({
			"nodes": [...store.nodes.values()].filter((node) => node.state !== "declared").map((node) => node.id),
			"channels": [...store.channels.values()].filter((channel) => channel.count > 0 || channel.linked),
			"topology": store.topology
		});
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
				h("p", null, "Boxes are where code runs: realms (windows, workers) and origins (iframes). Solid double lines are hub links — the tree every context's hub federates over; thin lines are channels the probes observe outside the hubs (workers, extension hosts, webviews, network). Dots are messages."),
				h("p", null, "Dashed means declared in the model (", h("code", null, "packages/vscode/architecture-model.ts"), ") but not seen yet; red means seen but not declared — fix the model or the code."),
				h("p", null, "Click a context or a line to inspect it.")
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
		const container = containers.find((candidate) => candidate.id === (node === undefined ? declared?.container : containerOf(node)));
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
				declared === undefined ? h("p", { "class": "arch-violations" }, "Not in the model.") : h("p", { "class": "arch-muted" }, "Observed by: " + declared.observedBy)
			),
			topology !== undefined && section(
				"Hub",
				keyValues([["Subscriptions", topology.subscriptions.length === 0 ? "none" : String(topology.subscriptions.length)]]),
				h("div", { "class": "arch-subjects" }, ...topology.subscriptions.map((subject) => h("span", { "class": "arch-subject" }, subject))),
				table(["Link", "Peer"], topology.links.map((entry) => [entry.id, entry.peerId === undefined ? "anonymous" : link(labelOf(store, entry.peerId), { "type": "node", "id": entry.peerId })]))
			),
			section("Channels", channels.length === 0 ? h("p", { "class": "arch-muted" }, "No traffic observed yet.") : table(["With", "Messages", "Bytes", "Rate"], channels.map((channel) => [
				h("span", null, link(labelOf(store, channel.a === id ? channel.b : channel.a), { "type": "edge", "id": channel.id }), declaredBetween(channel.a, channel.b) === undefined ? h("span", { "class": "arch-violations" }, " undeclared") : null),
				formatCount(channel.count),
				formatBytes(channel.bytes),
				formatRate(store.rate(channel, now))
			])))
		];
	}

	function renderEdge(id: string): Child[] {
		const edge = edges.get(id);
		const channel = edge?.channel ?? store.channels.get(id);
		const a = edge?.a ?? channel?.a;
		const b = edge?.b ?? channel?.b;

		if (a === undefined || b === undefined) {
			return [h("p", null, "This channel is gone.")];
		}

		const declared = declaredBetween(a, b);
		const families = declared?.type === "hub" ? familiesOnLink(a, b) : [];
		const header: Child[] = [
			h("h2", null, link(labelOf(store, a), { "type": "node", "id": a }), " ⇄ ", link(labelOf(store, b), { "type": "node", "id": b })),
			declared === undefined
				? h("div", { "class": "arch-state state-unresponsive" }, "undeclared: neither a hub link nor a channel in the model")
				: h("div", { "class": "arch-state " + (channel === undefined ? "state-declared" : "state-alive") }, (declared.type === "hub" ? "hub link" : "declared channel") + (channel === undefined ? ", not seen yet" : "")),
			declared?.type === "channel" && section(declared.spec.protocol, keyValues([["Transport", declared.spec.transport]]), h("p", null, declared.spec.description)),
			declared?.type === "hub" && section(
				"Subjects allowed across this link",
				h("div", { "class": "arch-subjects" }, ...families.map((family) => h("span", { "class": "arch-subject", "title": family.description }, family.pattern)))
			)
		];

		if (channel === undefined) {
			return header;
		}

		const unexpected = (label: string): boolean => {
			// Only hub-carried messages are subjects; a probe-observed message on the same pair isn't.
			const subject = declared?.type === "hub" && (channel.labels.get(label)?.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;

			return subject !== undefined && !families.some((family) => subjectMatches(family.pattern, subject));
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
				return h("span", null, link(labelOf(store, violation.a) + " ⇄ " + labelOf(store, violation.b), { "type": "edge", "id": store.channel(violation.a, violation.b).channel.id }, "arch-link arch-violations"), " — no hub link or channel in the model");
			case "unexpected-subject":
				return h("span", null, h("code", null, violation.subject), ` × ${formatCount(violation.count)} across `, link(labelOf(store, violation.a) + " ⇄ " + labelOf(store, violation.b), { "type": "edge", "id": store.channel(violation.a, violation.b).channel.id }), " — not among the hubs of any family that may cross it");
			case "duplicate-peer":
				return h("span", null, link(labelOf(store, violation.hub), { "type": "node", "id": violation.hub }), ` has ${violation.links} links to "${violation.peer}" — duplicate hub ids, or stale links`);
			case "unknown-node":
			default:
				return h("span", null, link(labelOf(store, violation.id), { "type": "node", "id": violation.id }, "arch-link arch-violations"), " — not in the model");
		}
	}

	function renderConformance(): Child[] {
		const violations = conformance();
		const observed = [...store.channels.values()].filter((channel) => channel.count > 0 || channel.linked);
		const seen = (a: string, b: string): boolean => observed.some((channel) => (channel.a === a && channel.b === b) || (channel.a === b && channel.b === a));
		const seenPattern = (a: string, b: string): number => observed.filter((channel) => {
			const declared = declaredBetween(channel.a, channel.b);

			return declared?.type === "channel" && declared.spec.a === a && declared.spec.b === b;
		}).length;

		return [
			section(
				"Summary",
				keyValues([
					["Hub links", `${hubLinks.filter(([a, b]) => seen(a, b)).length} / ${hubLinks.length} seen`],
					["Channels", `${declaredChannels.filter((channel) => seenPattern(channel.a, channel.b) > 0).length} / ${declaredChannels.length} seen`],
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
				seenPattern(channel.a, channel.b) > 0 ? String(seenPattern(channel.a, channel.b)) : "no"
			])))
		];
	}

	const filterInput = h("input", { "class": "arch-input", "placeholder": "Filter (context, message…)", "type": "search" });
	const logList = h("div", { "class": "arch-log" });

	filterInput.addEventListener("input", () => {
		logFilter = filterInput.value.toLowerCase();
		refreshPanel();
	});

	function renderLog(): Child[] {
		const rows: HTMLElement[] = [];

		for (let index = store.log.length - 1; index >= 0 && rows.length < 300; index -= 1) {
			const sample = store.log[index];

			if (!showAcks && sample.kind === "ack") {
				continue;
			}

			const channel = store.channels.get(sample.channel);

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
	const tabButtons = new Map<Tab, HTMLButtonElement>((["inspector", "conformance", "log"] as Tab[]).map((id) => {
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
		const labels: Record<Tab, string> = { "inspector": "Inspector", "conformance": violations > 0 ? `Conformance (${violations})` : "Conformance", "log": "Log" };

		for (const [id, element] of tabButtons) {
			element.textContent = labels[id];
			element.classList.toggle("active", id === tab);
		}

		// Don't move content under the mouse unless asked.
		if (!force && (panelHovered || paused)) {
			return;
		}

		const { scrollTop } = panel;
		const content = tab === "conformance" ? renderConformance() : tab === "log" ? renderLog() : selection === undefined ? renderOverview() : selection.type === "node" ? renderNode(selection.id) : renderEdge(selection.id);

		panel.replaceChildren(...content.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
		panel.scrollTop = force ? 0 : scrollTop;
	}

	// ── wiring
	disposables.push(store.onTopologyChange(scheduleRender), store.onSample(onSample));

	const interval = setInterval(() => {
		const now = Date.now();

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
