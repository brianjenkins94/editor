/**
 * The live architecture view (binding): draws the ArchitectureStore — fed by every context's `$sys.arch` reports
 * over the hub tree — against the declared model (architecture-model.ts). Boxes are realms/origins, nodes are
 * contexts, solid double lines are hub links, thin lines probed channels, dots the messages flowing. Declared but
 * idle channels are dashed; anything observed that the model doesn't declare is red.
 *
 * Plain DOM/SVG in the workbench realm (hosted by the component's editor pane): Web Awesome components and utility
 * classes, whose tokens theme/vscode maps onto the VS Code theme; only the diagram, the canvas layout and a few table
 * and log details are our own CSS (theme/exceptions/architecture-view.css).
 */
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type { Hub } from "@brianjenkins94/hub";
import type { ChannelStats, FlowMessage, RuntimeNode, StoredSample, TrafficKind } from "@brianjenkins94/observability";
import type { AppLayout, ContainerSpec, Violation } from "../shared/architecture-model";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { ArchitectureStore, collectArchReports, flowsOf, requestArchSync } from "@brianjenkins94/observability";
import css from "theme/exceptions/architecture-view.css?raw";
import { allowedOnLink, appLayout, appWindowOf, checkConformance, componentFor, componentsOf, containers, declaredBetween, channels as declaredChannels, nodes as declaredNodes, declaredOn, directionOnLink, DYNAMIC_PREFIXES, dynamicContainer, familiesOnLink, hubLinks, nodeSpec, seenChannels, subjects as subjectFamilies, subjectMatches, subjectOfLabel } from "../shared/architecture-model";
import { windowTitle } from "../shared/virtual-path";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tag/tag.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_HEIGHT = 44;
const NODE_WIDTH = 210;
/** A hub's component, a row beneath the hub's own in its box (DISCOVERED-ARCHITECTURE.md). */
const COMPONENT_HEIGHT = 20;
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

type Variant = "brand" | "neutral" | "success" | "warning" | "danger";

/** Each kind's Web Awesome variant: its chip's, and (in the exception CSS) its pulse's fill. An ack is neutral, outlined. */
const KIND_VARIANTS: Partial<Record<string, Variant>> = { "request": "brand", "reply": "success", "event": "neutral", "message": "warning", "error": "danger" };

/** A context's (or a line's) state, as a badge's variant. */
const STATE_VARIANTS: Partial<Record<string, Variant>> = { "alive": "success", "unresponsive": "danger" };

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
		setTimeout(() => {
			requestArchSync(hub);
		}, 200);
		// What needs review, for debug-mcp's architecture_state (the editor tab answers it: main.tsx).
		serve(hub, "architecture.violations", () => conformanceOf(store));

		// A handle for scripts (the architecture smoke test, a console): what the diagram knows, as data.
		const rpc = createRpcClient(hub);

		// eslint-disable-next-line ts/naming-convention -- the global the architecture harness and tour scripts read
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

function html<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | undefined> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
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

/** A message kind's chip. */
function chip(kind: string): HTMLElement {
	return html("wa-badge", { "variant": KIND_VARIANTS[kind] ?? "neutral", "appearance": kind in KIND_VARIANTS ? undefined : "outlined" }, kind);
}

/** A state, as an outlined pill. */
function stateBadge(state: string, text: string): HTMLElement {
	return html("wa-badge", { "variant": STATE_VARIANTS[state] ?? "neutral", "appearance": "outlined", "pill": "", "class": "wa-align-self-start" }, text);
}

/** Subjects (or patterns), each a tag; `unexpected` ones are danger. */
function subjectTags(subjects: { "text": string; "title"?: string; "unexpected"?: boolean }[]): HTMLElement {
	return html("div", { "class": "wa-cluster wa-gap-2xs" }, ...subjects.map(({ text, title, unexpected }) => html("wa-tag", { "size": "xs", "variant": unexpected === true ? "danger" : "neutral", "class": "arch-mono", "title": title }, text)));
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number | undefined> = {}, text?: string): SVGElementTagNameMap[K] {
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

function formatTime(time: number): string {
	const date = new Date(time);

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
		return html("p", { "class": "wa-color-text-quiet" }, "The previewed app's own context — its hubs joined the editor's tree through the shell's preview link. Its architecture, not the editor's: nothing in the model to check it against.");
	}

	const prefix = DYNAMIC_PREFIXES.find((candidate) => id.startsWith(candidate));

	return prefix === undefined
		? html("p", { "class": "arch-violations" }, "Not in the model.")
		: html("p", { "class": "wa-color-text-quiet" }, "Created at runtime — the model declares its channels as " + prefix + "*.");
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

/** A context's badge: how many instances run, or how many times it started. */
function badgeOf(node: RuntimeNode): string {
	if (node.instances > 1) {
		return "×" + node.instances;
	}

	return node.spawnCount > 1 ? node.spawnCount + " starts" : "";
}

/** A sample's ends, the way it went (none without its channel). */
function sampleEnds(sample: StoredSample, channel: ChannelStats | undefined): [string, string] {
	if (channel === undefined) {
		return ["", ""];
	}

	return sample.forward ? [channel.a, channel.b] : [channel.b, channel.a];
}

/** A context's facts, for the Inspector: those it lacks are left out. */
function contextFacts(id: string, node: RuntimeNode | undefined, declared: ReturnType<typeof nodeSpec>, container: ContainerSpec | undefined): [string, string | undefined][] {
	return [
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
	];
}

/** What the model declares a line as, in words. */
function declaredKindText(declared: NonNullable<ReturnType<typeof declaredOn>>): string {
	if (declared.type === "hub") {
		return "hub link";
	}

	if (declared.type === "discovered") {
		return declared.kind === "commands" ? "discovered: extensions' commands (VS Code's command surface)" : "discovered: a store, by what's written to it and read from it";
	}

	return "declared channel";
}

/** Cut `text` (in the document, so it can be measured) to `width` with an ellipsis; the whole of it, its tooltip. */
function fitText(text: SVGTextElement, width: number): void {
	const full = text.textContent ?? "";

	if (width <= 0 || text.getComputedTextLength() <= width) {
		return;
	}

	let [low, high] = [0, full.length];

	while (low < high) {
		const middle = Math.ceil((low + high) / 2);

		text.textContent = full.slice(0, middle) + "…";

		if (text.getComputedTextLength() <= width) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	text.textContent = full.slice(0, low).trimEnd() + "…";
	text.append(svgElement("title", {}, full));
}

// ── layout ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rect { "x": number; "y": number; "width": number; "height": number }
interface Layout {
	"width": number;
	"height": number;
	"nodes": Map<string, Rect>;
	/** A hub's whole box, its components' rows included (its `nodes` rect is the hub's own row, where its lines meet). */
	"boxes": Map<string, Rect>;
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
const drawnAsContainer = new Map(containers.filter((container) => container.node !== undefined).map((container) => [container.node, container.id]));

/** How far a previewed app's context is indented in its box, per level it's nested (see appLayout). */
const APP_INDENT = 14;

/** A hub's component, as a node id: its lines meet its row. */
function componentId(hub: string, component: string): string {
	return `component:${hub}:${component}`;
}

/** `components`: each hub's components, drawn as rows in its box. */
function computeLayout(visible: RuntimeNode[], collapsed: ReadonlySet<string>, appInfo: AppLayout, components: ReadonlyMap<string, string[]>): Layout {
	const app = appInfo.nodes;
	const heightOf = (id: string): number => NODE_HEIGHT + ((components.get(id)?.length ?? 0) > 0 ? components.get(id).length * COMPONENT_HEIGHT + 4 : 0);
	const order = new Map(declaredNodes.map((node, index) => [node.id, index]));
	const byContainer = new Map<string, RuntimeNode[]>();
	const visibleIds = new Set(visible.map((node) => node.id));

	for (const node of visible) {
		if (!drawnAsContainer.has(node.id)) {
			const list = byContainer.get(containerOf(node, app)) ?? [];

			list.push(node);
			byContainer.set(containerOf(node, app), list);
		}
	}

	for (const list of byContainer.values()) {
		list.sort((left, right) => ((order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity)) || left.id.localeCompare(right.id));
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
			for (const node of list.toSorted((left, right) => Number(left.id.includes(".")) - Number(right.id.includes(".")) || left.id.localeCompare(right.id))) {
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
			...(byContainer.get(container.id) ?? []).map((node) => ({ "width": NODE_WIDTH, "height": heightOf(node.id) })),
			...children(container).map(measure)
		];
		const width = Math.max(NODE_WIDTH, ...items.map((item) => item.width));
		const height = headerOf(container) + items.reduce((sum, item, index) => sum + item.height + (index > 0 ? GAP : 0), 0);
		const size = { "width": width + PADDING * 2, "height": height + PADDING };

		sizes.set(container.id, size);

		return size;
	};

	const layout: Layout = { "width": 0, "height": 0, "nodes": new Map(), "boxes": new Map(), "containers": new Map(), "hidden": new Map() };
	// A collapsed box's nodes, and its nested boxes', all stand at its header.
	const hide = (container: ContainerSpec, box: string, header: Rect): void => {
		for (const id of (byContainer.get(container.id) ?? []).flatMap((node) => [node.id, ...(components.get(node.id) ?? []).map((component) => componentId(node.id, component))])) {
			layout.nodes.set(id, header);
			layout.hidden.set(id, box);
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

			// Its components, each a row beneath it, indented.
			if ((components.get(node.id)?.length ?? 0) > 0) {
				const top = cursor;

				layout.boxes.set(node.id, { "x": x + PADDING + indent, "y": top, "width": inner - indent, "height": heightOf(node.id) });

				for (const [index, component] of components.get(node.id).entries()) {
					layout.nodes.set(componentId(node.id, component), { "x": x + PADDING + indent + 16, "y": top + NODE_HEIGHT + index * COMPONENT_HEIGHT, "width": inner - indent - 24, "height": COMPONENT_HEIGHT - 2 });
				}
			}

			cursor += heightOf(node.id) + GAP;
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

	const sorted = [...columns.entries()].sort(([left], [right]) => left - right).map(([, list]) => list);
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

/** An edge's status class: undeclared, or declared and seen (its traffic observed), or declared and idle (a ghost). */
function edgeStatus(type: string, observed: boolean): string {
	if (type === "undeclared") {
		return "undeclared";
	}

	return observed ? "declared" : "ghost";
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

/** A channel's kind in the Mermaid: what the model declares it as, or UNDECLARED. */
function mermaidKind(declared: ReturnType<typeof declaredOn>): string {
	if (declared === undefined) {
		return "UNDECLARED";
	}

	if (declared.type === "hub") {
		return "hub";
	}

	if (declared.type === "discovered") {
		return declared.kind === "commands" ? "commands" : "store";
	}

	return declared.spec.protocol;
}

/** Mermaid of what's OBSERVED, counts and all (ARCHITECTURE.md's, one of a kind each, is the tour's: `tourDiagram`). */
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
		const label = mermaidKind(declared) + (channel.medium === undefined ? "" : " via " + channel.medium) + " · " + formatCount(channel.count);

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
	/** `component`: a hub link's messages that one of its ends' components handles, drawn to that component's row. */
	"type": "hub" | "channel" | "discovered" | "undeclared" | "component";
	/** A component line's messages (its channel carries others too). */
	"labels"?: string[];
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

	root.classList.add("arch-root", "wa-stack", "wa-gap-0", "wa-body-s", "wa-color-text-normal");
	root.replaceChildren(html("style", null, css));

	// ── toolbar
	const summary = html("span", { "class": "wa-color-text-quiet" });
	// The feature lens: one feature lit, the rest faded — its features found in what's on the wire, refreshed as it opens.
	// (no feature lit is the select left empty: its placeholder, and its clear button to get back there)
	const featureSelect = html("wa-select", { "size": "s", "placeholder": "All features", "with-clear": "", "title": "Light up one feature — found in the subjects, commands and stores seen" });
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

		featureSelect.replaceChildren(...features.map((name) => html("wa-option", { "value": name }, name)));
		featureSelect.value = feature ?? "";
	};

	refreshFeatures();
	featureSelect.addEventListener("wa-show", refreshFeatures);
	featureSelect.addEventListener("change", () => {
		feature = featureSelect.value === "" || featureSelect.value === null ? undefined : String(featureSelect.value);
		applySelection();
		refreshPanel();
	});
	const button = (label: string, title: string, onClick: (element: WaButton) => void): WaButton => {
		const element = html("wa-button", { "size": "s", "variant": "neutral", "title": title }, label);

		element.addEventListener("click", () => {
			onClick(element);
		});

		return element;
	};

	// A toggle is on while it's the brand variant.
	const toggle = (label: string, title: string, initial: boolean, onChange: (value: boolean) => void): WaButton => {
		const element = button(label, title, () => {
			const value = element.variant !== "brand";

			element.variant = value ? "brand" : "neutral";
			onChange(value);
		});

		element.variant = initial ? "brand" : "neutral";

		return element;
	};

	const copy = (element: WaButton, text: string): void => {
		const label = element.textContent;

		void navigator.clipboard.writeText(text).then(() => {
			element.textContent = "Copied";
			setTimeout(() => {
				element.textContent = label;
			}, 1500);
		});
	};

	root.append(html(
		"div",
		{ "class": "arch-toolbar wa-split wa-gap-s" },
		html(
			"div",
			{ "class": "wa-cluster wa-gap-s" },
			html("span", { "class": "wa-heading-s" }, "Live architecture"),
			summary,
			html("span", { "class": "wa-cluster wa-gap-2xs" }, ...KINDS.map(chip))
		),
		html(
			"div",
			{ "class": "wa-cluster wa-gap-xs" },
			toggle("Pause", "Pause the animation and the log", paused, (value) => {
				paused = value;

				if (paused) {
					clearPulses();
				}
			}),
			toggle("Acks", "Show RPC acknowledgements", showAcks, (value) => {
				showAcks = value;
				refreshPanel();
			}),
			toggle("Payloads", "Capture what each message carries, everywhere (it records the app's data) — shown in a channel's recent traffic", capturing, (value) => {
				capturing = value;
				requestArchSync(hub, { "capture": value });
			}),
			toggle("Idle", "Show declared contexts that aren't running", showDeclared, (value) => {
				showDeclared = value;
				scheduleRender();
			}),
			featureSelect,
			button("−", "Zoom out", () => { setZoom(zoom / 1.2); }),
			button("Fit", "Fit the width", () => {
				autoFit = true;
				fit();
			}),
			button("+", "Zoom in", () => { setZoom(zoom * 1.2); }),
			button("Reset", "Reset the counters", () => {
				store.resetCounters();
				refreshPanel();
			}),
			button("Mermaid", "Copy the OBSERVED architecture as a Mermaid flowchart", (element) => { copy(element, observedMermaid(store)); }),
			button("Export", "Download a JSON snapshot of everything recorded", () => {
				const url = URL.createObjectURL(new Blob([JSON.stringify(store.snapshot(), null, 2)], { "type": "application/json" }));
				const link = html("a", { "href": url, "download": "architecture-" + new Date().toISOString().replaceAll(/[:.]/gu, "-") + ".json" });

				link.click();
				URL.revokeObjectURL(url);
			})
		)
	));

	// ── canvas + side panel
	const svg = svgElement("svg", { "class": "arch-svg" });
	const containerLayer = svgElement("g");
	const edgeLayer = svgElement("g");
	const nodeLayer = svgElement("g");
	const pulseLayer = svgElement("g");

	svg.append(containerLayer, edgeLayer, nodeLayer, pulseLayer);

	const canvas = html("div", { "class": "arch-canvas" }, svg);
	const tabs = html("wa-tab-group", { "without-scroll-controls": "" });
	const panel = html("div", { "class": "arch-panel wa-stack wa-gap-m" });

	root.append(html("div", { "class": "arch-body" }, canvas, html("div", { "class": "arch-side" }, tabs, panel)));

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
	const stopWheel = (event: WheelEvent): void => {
		event.stopPropagation();
	};

	root.addEventListener("wheel", stopWheel, { "passive": true });
	disposables.push(() => {
		root.removeEventListener("wheel", stopWheel);
	});

	// ── diagram
	let layout: Layout | undefined;
	/** A previewed app's own contexts, and how they nest, as of the last render (see appLayout). */
	let appInfo: AppLayout = { "nodes": new Set(), "parent": new Map() };
	let app: ReadonlySet<string> = appInfo.nodes;
	let edges = new Map<string, EdgeView>();
	let edgesByNode = new Map<string, EdgeView[]>();
	/** The Stores box's header, its stores, and the contexts with a line to every one of them — whose lines end at the
	 *  header, as into a collapsed box: one strand, not one a store (as of the last render). */
	let toStores: { "header": Rect; "stores": Set<string>; "contexts": Set<string> } | undefined;
	/** The contexts the last render drew, and each hub's components among them (DISCOVERED-ARCHITECTURE.md). */
	let drawnIds: string[] = [];
	let components = new Map<string, string[]>();
	/** Which component line a hub link's message rides (`<channel>\0<label>` → edge), as of the last render. */
	let routes = new Map<string, string>();
	/** The hub links' messages the last render placed: a new one re-renders, so its component gets its line. */
	const placed = new Set<string>();
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

	/** An edge's ends to draw, and whether it's a line to every store (`toAll`, see addEdge). */
	function edgeEnds(endA: string, endB: string): { "toAll": boolean; "from": Rect | undefined; "to": Rect | undefined } {
		const toAll = toStores !== undefined && ((toStores.contexts.has(endA) && toStores.stores.has(endB)) || (toStores.contexts.has(endB) && toStores.stores.has(endA)));
		const from = toAll && toStores.stores.has(endA) ? toStores.header : layout.nodes.get(endA);
		const to = toAll && toStores.stores.has(endB) ? toStores.header : layout.nodes.get(endB);

		return { "toAll": toAll, "from": from, "to": to };
	}

	/** An edge's type: what the model declares it as, else a previewed app's own channel or undeclared (see addEdge). */
	function edgeTypeOf(declared: ReturnType<typeof declaredOn>, endA: string, endB: string): EdgeView["type"] {
		if (declared !== undefined) {
			return declared.type;
		}

		return app.has(endA) || app.has(endB) ? "channel" : "undeclared";
	}

	function addEdge(id: string, endA: string, endB: string, channel: ChannelStats | undefined): void {
		// A context's line to a store, when it has one to every store: to the Stores box's header instead.
		const { toAll, from, to } = edgeEnds(endA, endB);

		// Both ends inside one collapsed box: nothing to draw.
		if (from === undefined || to === undefined || from === to) {
			return;
		}

		const declared = channel === undefined ? declaredBetween(endA, endB) : declaredOn(channel);
		// A previewed app's own lines are its business, not undeclared editor traffic.
		const type = edgeTypeOf(declared, endA, endB);
		const observed = channel !== undefined && (channel.count > 0 || channel.linked);
		const pathData = edgePath(from, to);
		const path = svgElement("path", { "d": pathData, "class": `arch-edge type-${type} status-${edgeStatus(type, observed)}` });
		const hit = svgElement("path", { "d": pathData, "class": "arch-edge-hit" });
		const intoCollapsed = layout.hidden.has(endA) || layout.hidden.has(endB) || toAll;
		// Into a collapsed box, a box's lines overlap: their numbers would too, so they go unlabelled.
		const group = svgElement("g", { "data-edge": id, "class": intoCollapsed ? "into-collapsed" : undefined });
		let label: SVGTextElement | undefined;

		group.append(path, hit);

		if (observed) {
			const middle = path.getPointAtLength(path.getTotalLength() / 2);

			label = svgElement("text", { "x": middle.x, "y": middle.y - 4, "class": "arch-edge-label" });
			group.append(label);
		}

		hit.addEventListener("click", (event) => {
			event.stopPropagation();
			select({ "type": "edge", "id": id });
		});
		hit.addEventListener("mouseenter", () => {
			group.classList.add("hover");
		});
		hit.addEventListener("mouseleave", () => {
			group.classList.remove("hover");
		});
		edgeLayer.append(group);

		const view: EdgeView = { "id": id, "a": endA, "b": endB, "channel": channel, "type": type, "observed": observed, "path": path, "label": label, "length": path.getTotalLength(), "inFlight": 0 };

		edges.set(id, view);

		// A collapsed box's header highlights its nodes' lines: they're filed under the box too (and the Stores box's, the
		// lines that end at it).
		for (const end of [endA, endB, ...[endA, endB].map((node) => layout.hidden.get(node)).filter((box) => box !== undefined).map((box) => "box:" + box), ...toAll ? ["box:stores"] : []]) {
			edgesByNode.set(end, [...edgesByNode.get(end) ?? [], view]);
		}
	}

	/** Each hub's components (its subscriptions by registering function, or namespace), past the reporter's own
	 *  `$sys.arch` (every hub has it, and its traffic isn't counted) — not a previewed app's, nor a box's (sw). */
	function componentsNow(ids: string[]): Map<string, string[]> {
		return new Map(ids.flatMap((id) => {
			const topology = store.topology.get(id);

			if (topology === undefined || app.has(id) || drawnAsContainer.has(id)) {
				return [];
			}

			const names = componentsOf({ ...topology, "subscriptions": topology.subscriptions.filter((subject) => !subject.startsWith("$sys.arch")) }).map(({ component }) => component);

			return names.length === 0 ? [] : [[id, names] as const];
		}));
	}

	/** A component line: `labels` of `channel` (a hub link), between `endA` and `endB` — its ends, or a component of either. */
	function addComponentEdge(channel: ChannelStats, endA: string, endB: string, labels: string[]): void {
		const from = layout.nodes.get(endA);
		const to = layout.nodes.get(endB);

		// Into a collapsed box, the link's own line says it.
		if (from === undefined || to === undefined || layout.hidden.has(endA) || layout.hidden.has(endB)) {
			return;
		}

		const id = `component:${channel.id}:${endA}:${endB}`;
		const pathData = edgePath(from, to);
		const path = svgElement("path", { "d": pathData, "class": "arch-edge type-component status-declared" });
		const hit = svgElement("path", { "d": pathData, "class": "arch-edge-hit" });
		const group = svgElement("g", { "data-edge": id });

		group.append(path, hit, svgElement("title", {}, labels.join("\n")));
		// The link it rides: its counts, its messages.
		hit.addEventListener("click", (event) => {
			event.stopPropagation();
			select({ "type": "edge", "id": channel.id });
		});
		hit.addEventListener("mouseenter", () => {
			group.classList.add("hover");
		});
		hit.addEventListener("mouseleave", () => {
			group.classList.remove("hover");
		});
		edgeLayer.append(group);

		const view: EdgeView = { "id": id, "a": endA, "b": endB, "channel": channel, "type": "component", "labels": labels, "observed": true, "path": path, "length": path.getTotalLength(), "inFlight": 0 };

		edges.set(id, view);

		for (const label of labels) {
			routes.set(channel.id + "\0" + label, id);
		}

		// Filed under its ends, and the hubs they're in: hovering a hub lights its components' lines too.
		for (const end of new Set([endA, endB, channel.a, channel.b])) {
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

		drawnIds = drawn.map((node) => node.id);
		components = componentsNow(drawnIds);
		layout = computeLayout(drawn, collapsed, appInfo, components);
		svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
		applyZoom();
		clearPulses();

		containerLayer.replaceChildren();

		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (rect !== undefined) {
				drawContainer(container, rect, visible, visibleIds);
			}
		}

		edgeLayer.replaceChildren();
		edges = new Map();
		edgesByNode = new Map();
		toStores = storesStrand(drawn, visibleIds);
		drawChannelEdges(media, visibleIds);
		drawComponentEdges(visibleIds);

		nodeLayer.replaceChildren();
		nodeElements.clear();

		for (const node of drawn) {
			// Drawn as its container, or folded into a collapsed one (above).
			if (!drawnAsContainer.has(node.id) && !layout.hidden.has(node.id)) {
				drawNode(node);
			}
		}

		drawContainerHeaders(visibleIds);
		applySelection();
		tick();

		if (autoFit) {
			fit();
		}
	}

	/** A container's box, at `rect`. */
	function drawContainer(container: ContainerSpec, rect: Rect, visible: RuntimeNode[], visibleIds: ReadonlySet<string>): void {
		const standsFor = container.node !== undefined && visibleIds.has(container.node) ? visible.find((node) => node.id === container.node) : undefined;
		// A box that stands for a node carries that node's status dot (and hub size) before its label.
		const nodeClasses = standsFor === undefined ? "" : ` is-node state-${standsFor.state}${nodeSpec(standsFor.id)?.hub === true ? " is-hub" : ""}`;
		const group = svgElement("g", { "class": "arch-container kind-" + (container.kind === "process" ? "remote" : container.kind) + nodeClasses, "data-node": standsFor?.id });
		// Standing for a node, the header lays out like that node's box: dot, label, then the caption as its detail line.
		const text = standsFor === undefined ? { "x": rect.x + 10, "label": rect.y + 15, "caption": rect.y + 27 } : { "x": rect.x + 22, "label": rect.y + 19, "caption": rect.y + 34 };
		const collapsible = container.collapsed !== undefined;

		// A collapsible box's chevron sits where a node's dot would.
		if (collapsible) {
			text.x = rect.x + 22;
		}

		// Standing for a node, the line beneath is that node's detail, as on a node's box (the caption is in the Inspector).
		const caption = svgElement("text", { "x": text.x, "y": text.caption, "class": "arch-container-caption" }, standsFor === undefined ? container.caption : detailOf(standsFor));

		group.append(
			svgElement("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height, "rx": 8 }),
			svgElement("text", { "x": text.x, "y": text.label, "class": "arch-container-label" }, container.label),
			caption
		);

		if (standsFor !== undefined) {
			group.append(svgElement("circle", { "cx": rect.x + 11, "cy": rect.y + 15, "r": 4, "class": "arch-node-dot" }));
		}

		if (collapsible) {
			const isCollapsed = collapsed.has(container.id);

			group.classList.toggle("is-collapsed", isCollapsed);
			group.append(svgElement("path", { "d": isCollapsed ? `M ${rect.x + 9} ${rect.y + 8} l 4 4 l -4 4` : `M ${rect.x + 7} ${rect.y + 10} l 4 4 l 4 -4`, "class": "arch-container-chevron" }));

			if (isCollapsed) {
				const count = [...layout.hidden.values()].filter((box) => box === container.id).length;

				group.append(svgElement("text", { "x": rect.x + rect.width - 8, "y": rect.y + 15, "class": "arch-node-badge", "text-anchor": "end" }, count === 0 ? "" : String(count)));
			}
		}

		containerLayer.append(group);
		fitText(caption, rect.x + rect.width - 8 - text.x);
	}

	/** The contexts with a line to every store in the Stores box (open, with more than one store): those lines end at
	 *  its header — one strand from each (a box's lines to a collapsed box do the same). */
	function storesStrand(drawn: RuntimeNode[], visibleIds: ReadonlySet<string>): typeof toStores {
		const storesBox = layout.containers.get("stores");
		const storeIds = new Set(drawn.filter((node) => containerOf(node, app) === "stores" && !layout.hidden.has(node.id)).map((node) => node.id));
		const reached = new Map<string, Set<string>>();

		for (const { a, b } of store.channels.values()) {
			for (const [context, other] of [[a, b], [b, a]]) {
				if (storeIds.has(other) && !storeIds.has(context) && visibleIds.has(context)) {
					reached.set(context, (reached.get(context) ?? new Set()).add(other));
				}
			}
		}

		const toEvery = [...reached].filter(([, stores]) => stores.size === storeIds.size).map(([context]) => context);

		return storesBox === undefined || storeIds.size < 2 || toEvery.length === 0 ? undefined : { "header": { ...storesBox, "height": HEADER }, "stores": storeIds, "contexts": new Set(toEvery) };
	}

	/** The observed channels' lines, then the declared ones not observed. */
	function drawChannelEdges(media: ReturnType<ArchitectureStore["media"]>, visibleIds: ReadonlySet<string>): void {
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
		const present = (endA: string, endB: string): boolean => store.between(endA, endB) !== undefined || media.get(endA)?.includes(endB) === true || media.get(endB)?.includes(endA) === true;

		for (const [endA, endB] of hubLinks) {
			if (!present(endA, endB) && visibleIds.has(endA) && visibleIds.has(endB)) {
				addEdge("declared:" + endA + "|" + endB, endA, endB, undefined);
			}
		}

		for (const channel of declaredChannels) {
			if (!channel.a.includes("*") && !channel.b.includes("*") && !present(channel.a, channel.b) && visibleIds.has(channel.a) && visibleIds.has(channel.b)) {
				addEdge("declared:" + channel.a + "|" + channel.b, channel.a, channel.b, undefined);
			}
		}
	}

	/** A hub link's messages, each to the component on either end that handles it (componentFor): a thin line per pair
	 *  of ends, beside the link's own (which keeps its counts). A message no component on either end handles — one
	 *  both only relay — stays on the link alone. */
	function drawComponentEdges(visibleIds: ReadonlySet<string>): void {
		routes = new Map();

		// Where `subject` lands on hub `end`: the component handling it, or the hub itself.
		const handlerOf = (end: string, subject: string): string => {
			const topology = store.topology.get(end);
			const component = topology === undefined || !components.has(end) ? undefined : componentFor(topology, subject);

			return component === undefined ? end : componentId(end, component);
		};

		for (const channel of store.channels.values()) {
			if (visibleIds.has(channel.a) && visibleIds.has(channel.b) && declaredOn(channel)?.type === "hub") {
				const pairs = new Map<string, string[]>();

				for (const [label, stats] of channel.labels) {
					const subject = (stats.hub ?? 0) > 0 ? subjectOfLabel(label) : undefined;

					placed.add(channel.id + "\0" + label);

					if (subject !== undefined && !subject.startsWith("$")) {
						const [endA, endB] = [handlerOf(channel.a, subject), handlerOf(channel.b, subject)];

						if (endA !== channel.a || endB !== channel.b) {
							pairs.set(endA + "\0" + endB, [...pairs.get(endA + "\0" + endB) ?? [], label]);
						}
					}
				}

				for (const [pair, labels] of pairs) {
					const [endA, endB] = pair.split("\0");

					addComponentEdge(channel, endA, endB, labels);
				}
			}
		}
	}

	/** A context's box, and its components' rows. */
	function drawNode(node: RuntimeNode): void {
		const rect = layout.nodes.get(node.id);
		const declared = nodeSpec(node.id);
		// Declared by id, created at runtime under a prefix the model declares (preview:, vite:, worker: …), or the
		// previewed app's own.
		const known = declared !== undefined || DYNAMIC_PREFIXES.some((prefix) => node.id.startsWith(prefix)) || app.has(node.id);
		const group = svgElement("g", { "class": `arch-node state-${node.state}${declared?.hub === true ? " is-hub" : ""}`, "data-node": node.id });

		group.append(
			svgElement("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": layout.boxes.get(node.id)?.height ?? rect.height, "rx": 6, "class": known ? undefined : "undeclared" }),
			svgElement("circle", { "cx": rect.x + 11, "cy": rect.y + 15, "r": 4, "class": "arch-node-dot" }),
			svgElement("text", { "x": rect.x + 22, "y": rect.y + 19, "class": "arch-node-label" }, labelOf(store, node.id)),
			svgElement("text", { "x": rect.x + 22, "y": rect.y + 34, "class": "arch-node-detail" }, detailOf(node)),
			svgElement("text", { "x": rect.x + rect.width - 8, "y": rect.y + 19, "class": "arch-node-badge", "text-anchor": "end" })
		);
		group.addEventListener("click", (event) => {
			event.stopPropagation();
			select({ "type": "node", "id": node.id });
		});
		group.addEventListener("mouseenter", () => {
			setHovered(node.id);
		});
		group.addEventListener("mouseleave", () => {
			setHovered(undefined);
		});
		nodeLayer.append(group);
		nodeElements.set(node.id, group);

		// Its components, each a row: hovering one lights its lines; a click picks the hub (its inspector lists them).
		for (const component of components.get(node.id) ?? []) {
			const id = componentId(node.id, component);
			const row = layout.nodes.get(id);
			const element = svgElement("g", { "class": "arch-component-row", "data-node": id });

			element.append(
				svgElement("rect", { "x": row.x, "y": row.y, "width": row.width, "height": row.height, "rx": 4 }),
				svgElement("text", { "x": row.x + 8, "y": row.y + 13, "class": "arch-component-label" }, component)
			);
			element.addEventListener("click", (event) => {
				event.stopPropagation();
				select({ "type": "node", "id": node.id });
			});
			element.addEventListener("mouseenter", () => {
				setHovered(id);
			});
			element.addEventListener("mouseleave", () => {
				setHovered(undefined);
			});
			nodeLayer.append(element);
			nodeElements.set(id, element);
		}
	}

	/** The boxes' headers, on the node layer — above the lines, which all end at a header. */
	function drawContainerHeaders(visibleIds: ReadonlySet<string>): void {
		// A box that stands for a node: its header selects and highlights that node, like the node's own box would.
		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (container.node !== undefined && rect !== undefined && visibleIds.has(container.node)) {
				const standsFor = container.node;
				const header = svgElement("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": headerOf(container), "rx": 8, "class": "arch-container-hit", "data-node": standsFor });

				header.addEventListener("click", (event) => {
					event.stopPropagation();
					select({ "type": "node", "id": standsFor });
				});
				header.addEventListener("mouseenter", () => {
					setHovered(standsFor);
				});
				header.addEventListener("mouseleave", () => {
					setHovered(undefined);
				});
				nodeLayer.append(header);
			}
		}

		// A collapsible box's header opens and closes it; hovering it highlights its nodes' lines.
		for (const container of containers) {
			const rect = layout.containers.get(container.id);

			if (container.collapsed !== undefined && rect !== undefined) {
				const header = svgElement("rect", { "x": rect.x, "y": rect.y, "width": rect.width, "height": HEADER, "rx": 8, "class": "arch-container-hit" });
				const box = "box:" + container.id;

				header.append(svgElement("title", {}, collapsed.has(container.id) ? "Expand" : "Collapse"));
				header.addEventListener("click", (event) => {
					event.stopPropagation();

					if (!collapsed.delete(container.id)) {
						collapsed.add(container.id);
					}

					saveCollapsed(collapsed);
					setHovered(undefined);
					scheduleRender();
				});
				header.addEventListener("mouseenter", () => {
					setHovered(box);
				});
				header.addEventListener("mouseleave", () => {
					setHovered(undefined);
				});
				nodeLayer.append(header);
			}
		}
	}

	/** Mark the contexts in focus, and the one selected. */
	function markNodes(focusNode: string | undefined, focusEdge: EdgeView | undefined): void {
		for (const [id, element] of nodeElements) {
			// A hub focused, its components are too.
			element.classList.toggle("focus", id === focusNode || id === focusEdge?.a || id === focusEdge?.b || (focusNode !== undefined && id.startsWith(componentId(focusNode, ""))));
			element.classList.toggle("selected", selection?.type === "node" && selection.id === id);
		}
	}

	/** Light up `lens`'s edges, and the contexts at their ends. */
	function applyFeatureLens(lens: string): void {
		const texts = (edge: EdgeView): string[] => (edge.labels === undefined ? featureTexts(edge.channel) : edge.labels.flatMap((label) => subjectOfLabel(label) ?? []));
		const lit = [...edges.values()].filter((edge) => edge.channel !== undefined && texts(edge).some((text) => wordsOf(text).includes(lens)));
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
			applyFeatureLens(feature);

			return;
		}

		svg.classList.toggle("has-focus", focusNode !== undefined || focusEdge !== undefined);
		markNodes(focusNode, focusEdge);

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
			// A component line's width is its own (its link's rate is the link's).
			if (edge.channel !== undefined && edge.type !== "component") {
				const rate = store.rate(edge.channel, now);

				total += rate;

				// An idle line (a ghost) keeps its stylesheet's thin width.
				if (!edge.path.classList.contains("status-ghost")) {
					// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: the width follows the live rate (a stroke-width attribute would lose to the stylesheet)
					edge.path.style.strokeWidth = String((edge.type === "hub" ? 2.5 : 1.5) + Math.min(4, Math.log2(1 + rate)));
				}

				if (edge.label !== undefined) {
					edge.label.textContent = edge.channel.count > 0 ? formatCount(edge.channel.count) + (rate > 0 ? " · " + formatRate(rate) : "") : "linked";
				}
			}
		}

		for (const [id, element] of nodeElements) {
			const node = store.nodes.get(id);

			element.classList.toggle("active", now - (lastActivity.get(id) ?? -Infinity) < 600);

			const badge = element.querySelector(".arch-node-badge");

			if (badge !== null && node !== undefined) {
				badge.textContent = badgeOf(node);
			}
		}

		// A hub's subscriptions change without a new context or channel (the store says nothing): its rows follow.
		if (JSON.stringify([...componentsNow(drawnIds)]) !== JSON.stringify([...components])) {
			scheduleRender();
		}

		const alive = [...store.nodes.values()].filter((node) => node.state === "alive").length;
		const violations = conformance().length;

		summary.replaceChildren(
			`${alive} contexts · ${store.channels.size} channels · ${store.reporters.size} reporters · ${formatRate(total)}`,
			violations > 0 ? html("span", { "class": "arch-violations" }, ` · ${violations} to review`) : ""
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

		// A message a component handles rides its line; one new to a hub link re-renders, to find it its component.
		const key = channel.id + "\0" + sample.label;

		if (!placed.has(key) && declaredOn(channel)?.type === "hub") {
			placed.add(key);
			scheduleRender();
		}

		const edge = edges.get(routes.get(key) ?? channel.id);

		if (paused || edge === undefined || (sample.kind === "ack" && !showAcks) || edge.inFlight >= MAX_PULSES_PER_EDGE || pulses.length >= MAX_PULSES || document.hidden) {
			return;
		}

		const element = svgElement("circle", { "r": 3.5, "class": "arch-pulse k-" + sample.kind });

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

	function link(label: string, target: Selection, className = "wa-link"): HTMLAnchorElement {
		const element = html("a", { "class": className, "href": "#" }, label);

		element.addEventListener("click", (event) => {
			event.preventDefault();
			select(target);
		});

		return element;
	}

	const section = (title: string, ...content: Child[]): HTMLElement => html("section", { "class": "wa-stack wa-gap-xs" }, html("h3", { "class": "wa-caption-xs wa-text-uppercase wa-font-weight-semibold" }, title), ...content);
	const keyValues = (entries: [string, Node | string | undefined][]): HTMLElement => html("dl", { "class": "arch-kv" }, ...entries.filter(([, value]) => value !== undefined && value !== "").flatMap(([key, value]) => [html("dt", { "class": "wa-color-text-quiet" }, key), html("dd", null, value)]));
	const table = (headers: string[], rows: Child[][]): HTMLElement => html("table", { "class": "arch-table" }, html("tr", null, ...headers.map((header) => html("th", null, header))), ...rows.map((row) => html("tr", null, ...row.map((cell) => html("td", { "class": "wa-text-truncate" }, cell)))));

	function sampleRow(sample: StoredSample, channel: ChannelStats | undefined, withEndpoints: boolean): HTMLElement {
		const [from, to] = sampleEnds(sample, channel);
		// What it carried, when payload capture was on: on a line of its own, below.
		const row = html(
			"div",
			{ "class": "arch-event wa-cluster wa-gap-xs wa-align-items-baseline wa-font-size-xs wa-text-nowrap " + (sample.payload === undefined ? "wa-flex-nowrap" : "wa-flex-wrap") },
			html("span", { "class": "arch-mono wa-color-text-quiet" }, formatTime(sample.t)),
			chip(sample.kind),
			withEndpoints ? html("span", { "class": "arch-event-endpoints wa-color-text-quiet wa-text-truncate" }, labelOf(store, from) + " → " + labelOf(store, to)) : html("span", null, sample.forward ? "→" : "←"),
			html("span", { "class": "arch-mono wa-text-truncate", "title": sample.label }, sample.label),
			html("span", { "class": "arch-event-bytes arch-mono wa-color-text-quiet" }, sample.bytes > 0 ? formatBytes(sample.bytes) : ""),
			sample.payload !== undefined && html("pre", { "class": "arch-event-payload arch-mono wa-color-text-quiet" }, sample.payload)
		);

		if (channel !== undefined && withEndpoints) {
			row.addEventListener("click", () => {
				select({ "type": "edge", "id": channel.id });
			});
		}

		return row;
	}

	function renderOverview(): Child[] {
		const now = Date.now();
		const busiest = [...store.channels.values()].sort((left, right) => right.count - left.count).slice(0, 12);

		return [
			section(
				"How to read it",
				html("p", null, "Boxes are where code runs: realms (windows, workers) and origins (iframes). Solid double lines are hub links — the tree every context's hub federates over; thin lines are channels the probes observe outside the hubs (workers, extension hosts, network). Dots are messages."),
				html("p", null, "Dashed means declared in the model (", html("code", null, "packages/editor/shared/architecture-model.ts"), ") but not seen yet; red means seen but not declared — fix the model or the code. Green lines were discovered, not declared: an extension's commands, and what's written to a store and read from it."),
				html("p", null, "The rows in a hub's box are its components — what subscribed to it, by the function that did (or by namespace, where the build kept no names). A thin line from a row carries the messages that component handles; the hub link beside it keeps the counts."),
				html("p", null, "Click a context or a line to inspect it. Pick a feature beside Idle to light only its part.")
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
		const channels = [...store.channels.values()].filter((channel) => channel.a === id || channel.b === id).sort((left, right) => right.count - left.count);
		const topology = store.topology.get(id);

		return [
			html("h2", { "class": "wa-heading-m" }, labelOf(store, id)),
			stateBadge(node?.state ?? "declared", node?.state ?? "not seen yet"),
			section(
				"Context",
				keyValues(contextFacts(id, node, declared, container)),
				html("p", null, declared?.description ?? ""),
				declared === undefined ? undeclaredNote(id, app) : html("p", { "class": "wa-color-text-quiet" }, "Observed by: " + declared.observedBy)
			),
			// What's inside it, discovered: its subscriptions grouped by the function that registered them (DISCOVERED-ARCHITECTURE.md).
			topology !== undefined && section(
				"Components",
				html("p", { "class": "wa-color-text-quiet" }, "What subscribed to this hub, by the function that registered it (or, where no name survived the build, by namespace)."),
				...componentsOf(topology).map(({ component, subjects }) => html("div", { "class": "wa-stack wa-gap-3xs" }, html("div", { "class": "wa-font-weight-semibold" }, component), subjectTags(subjects.map((subject) => ({ "text": subject })))))
			),
			topology !== undefined && section(
				"Hub",
				keyValues([["Subscriptions", topology.subscriptions.length === 0 ? "none" : String(topology.subscriptions.length)]]),
				subjectTags(topology.subscriptions.map((subject) => ({ "text": subject }))),
				table(["Link", "Peer"], topology.links.map((entry) => [entry.id, entry.peerId === undefined ? "anonymous" : link(labelOf(store, entry.peerId), { "type": "node", "id": entry.peerId })]))
			),
			section("Channels", channels.length === 0 ? html("p", { "class": "wa-color-text-quiet" }, "No traffic observed yet.") : table(["With", "Messages", "Bytes", "Rate"], channels.map((channel) => [
				html("span", null, link(labelOf(store, channel.a === id ? channel.b : channel.a), { "type": "edge", "id": channel.id }), declaredOn(channel) === undefined ? html("span", { "class": "arch-violations" }, " undeclared") : null),
				formatCount(channel.count),
				formatBytes(channel.bytes),
				formatRate(store.rate(channel, now))
			])))
		];
	}

	/** An edge's Inspector header: its ends, its medium, its state, and what the model says crosses it. */
	function edgeHeader(endA: string, endB: string, channel: ChannelStats | undefined, declared: ReturnType<typeof declaredOn>): Child[] {
		const families = declared?.type === "hub" ? familiesOnLink(endA, endB) : [];

		return [
			html("h2", { "class": "wa-heading-m" }, link(labelOf(store, endA), { "type": "node", "id": endA }), " ⇄ ", link(labelOf(store, endB), { "type": "node", "id": endB })),
			channel?.medium !== undefined && html("p", { "class": "wa-color-text-quiet" }, "Through ", html("code", null, labelOf(store, channel.medium)), ` (${store.nodes.get(channel.medium)?.spec.detail ?? "a channel"}) — only these two use it.`),
			edgeState(endA, endB, channel, declared),
			declared?.type === "channel" && section(declared.spec.protocol, keyValues([["Transport", declared.spec.transport], ["Not a hub link because", declared.spec.reason]]), html("p", null, declared.spec.description)),
			declared?.type === "hub" && section(
				"Subjects allowed across this link",
				html("p", { "class": "wa-color-text-quiet" }, "Each the way its events and calls go: → toward ", html("code", null, labelOf(store, endB)), ", ← toward ", html("code", null, labelOf(store, endA)), "."),
				subjectTags(families.map((family) => ({ "text": `${directionOnLink(family, endA, endB) ?? ""} ${family.pattern}`, "title": `from ${family.from.join(", ") || "nobody"} to ${family.to.join(", ") || "nobody"}` })))
			)
		];
	}

	/** An edge's state: the previewed app's own, undeclared, or what the model declares it as (and whether it's seen). */
	function edgeState(endA: string, endB: string, channel: ChannelStats | undefined, declared: ReturnType<typeof declaredOn>): HTMLElement {
		if (declared === undefined && (app.has(endA) || app.has(endB))) {
			return stateBadge("alive", "the previewed app's own — not in the editor's model");
		}

		if (declared === undefined) {
			return stateBadge("unresponsive", "undeclared: neither a hub link nor a channel in the model");
		}

		return stateBadge(channel === undefined ? "declared" : "alive", declaredKindText(declared) + (channel === undefined ? ", not seen yet" : ""));
	}

	function renderEdge(id: string): Child[] {
		const edge = edges.get(id);
		const channel = edge?.channel ?? store.channelById(id);
		const endA = edge?.a ?? channel?.a;
		const endB = edge?.b ?? channel?.b;

		if (endA === undefined || endB === undefined) {
			return [html("p", null, "This channel is gone.")];
		}

		const declared = channel === undefined ? declaredBetween(endA, endB) : declaredOn(channel);
		const header = edgeHeader(endA, endB, channel, declared);

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

			return (stats.forward > 0 && !allowedOnLink(label, endA, endB)) || (stats.backward > 0 && !allowedOnLink(label, endB, endA));
		};

		const labels = [...channel.labels.entries()].filter(([label]) => showAcks || !label.startsWith("ack ")).sort(([, x], [, y]) => y.count - x.count);
		const recent = channel.recent.filter((sample) => showAcks || sample.kind !== "ack").slice(-80).reverse();

		return [
			...header,
			Object.keys(channel.interest).length > 0 && section(
				"Interest",
				...Object.entries(channel.interest).map(([hubId, interest]) => html(
					"div",
					null,
					html("p", { "class": "wa-color-text-quiet" }, labelOf(store, hubId === endA ? endB : endA) + " asked " + labelOf(store, hubId) + " for:"),
					subjectTags(interest.map((subject) => ({ "text": subject })))
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
				html("p", { "class": "wa-color-text-quiet" }, "→ is " + labelOf(store, channel.a) + " to " + labelOf(store, channel.b))
			),
			section(`Messages (${labels.length} distinct)`, table(["Message", "→", "←", "Bytes"], labels.slice(0, 50).map(([label, stats]) => [
				html("span", { "class": "arch-mono" + (unexpected(label) ? " arch-violations" : ""), "title": unexpected(label) ? "not allowed across this link by the model" : label }, label),
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
				return html("span", null, link(labelOf(store, violation.a) + " ⇄ " + labelOf(store, violation.b), { "type": "edge", "id": store.between(violation.a, violation.b)?.id ?? violation.a + "|" + violation.b }, "wa-link arch-violations"), " — no hub link or channel in the model");
			case "unexpected-subject":
				return html("span", null, html("code", null, violation.subject), ` × ${formatCount(violation.count)} across `, link(labelOf(store, violation.a) + " ⇄ " + labelOf(store, violation.b), { "type": "edge", "id": store.between(violation.a, violation.b)?.id ?? violation.a + "|" + violation.b }), " — not among the hubs of any family that may cross it");
			case "duplicate-peer":
				return html("span", null, link(labelOf(store, violation.hub), { "type": "node", "id": violation.hub }), ` has ${violation.links} links to "${violation.peer}" — duplicate hub ids, or stale links`);
			case "unknown-node":
			default:
				return html("span", null, link(labelOf(store, violation.id), { "type": "node", "id": violation.id }, "wa-link arch-violations"), " — not in the model");
		}
	}

	function renderConformance(): Child[] {
		const violations = conformance();
		const observed = [...store.channels.values()].filter((channel) => channel.count > 0 || channel.linked);
		const seen = (endA: string, endB: string): boolean => observed.some((channel) => (channel.a === endA && channel.b === endB) || (channel.a === endB && channel.b === endA));
		const seenByChannel = seenChannels(observed);

		return [
			section(
				"Summary",
				keyValues([
					["Hub links", `${hubLinks.filter(([endA, endB]) => seen(endA, endB)).length} / ${hubLinks.length} seen`],
					["Channels", `${declaredChannels.filter((channel) => seenByChannel.has(channel)).length} / ${declaredChannels.length} seen`],
					["To review", String(violations.length)]
				]),
				html("p", { "class": "wa-color-text-quiet" }, "The model: packages/editor/shared/architecture-model.ts. Change it with the architecture.")
			),
			section("To review", violations.length === 0 ? html("p", { "class": "wa-color-text-quiet" }, "Nothing — everything observed matches the model.") : html("ul", { "class": "wa-list-plain wa-stack wa-gap-2xs" }, ...violations.map((violation) => html("li", null, describeViolation(violation))))),
			section("Hub links", table(["Link", "Messages"], hubLinks.map(([endA, endB]) => {
				const channel = observed.find((candidate) => (candidate.a === endA && candidate.b === endB) || (candidate.a === endB && candidate.b === endA));

				return [channel === undefined ? `${endA} ⇄ ${endB}` : link(`${endA} ⇄ ${endB}`, { "type": "edge", "id": channel.id }), channel === undefined ? "not seen" + (nodeSpec(endB)?.condition === undefined ? "" : ` (${nodeSpec(endB).condition})`) : formatCount(channel.count)];
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
			section("Rules no traffic touched", rules.length === 0 ? html("p", { "class": "wa-color-text-quiet" }, "Every subject family was seen this session.") : table(["Subject", "From → to"], rules.map((family) => [family.pattern, `${family.from.join(", ")} → ${family.to.join(", ")}`]))),
			section("Components no traffic touched", components.length === 0 ? html("p", { "class": "wa-color-text-quiet" }, "Every discovered component heard something this session.") : table(["Component", "Of", "Serves and hears"], components.map(({ hub, component, subjects }) => [component, labelOf(store, hub), subjects.join(", ")])))
		];
	}

	const filterInput = html("wa-input", { "size": "s", "placeholder": "Filter (context, message…)", "type": "search" });
	const logList = html("div", { "class": "arch-log" });

	filterInput.addEventListener("input", () => {
		logFilter = (filterInput.value ?? "").toLowerCase();
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
		const flows = grouped(flowsOf(samples).filter((flow) => !flow.label.startsWith("$sys") && (feature === undefined ? flow.caused.length > 0 : everything(flow).some((message) => wordsOf(message.label).includes(feature))))).reverse().slice(0, 40);
		// Where a message ends: its last hub, and the component there that handles it (a reply's is its caller's machinery).
		const handledBy = (message: FlowMessage): string => {
			const end = message.path.at(-1);
			const topology = store.topology.get(end);
			const subject = message.label.startsWith("↩") ? undefined : subjectOfLabel(message.label);
			const component = topology === undefined || subject === undefined ? undefined : componentFor(topology, subject);

			return labelOf(store, end) + (component === undefined ? "" : " · " + component);
		};

		const line = (message: FlowMessage, count: number, depth: number): HTMLElement[] => [
			html("div", { "class": "wa-text-truncate" + (message.inferred === true ? " arch-inferred" : ""), "style": `padding-left: ${depth * 14}px`, "title": message.inferred === true ? "linked by timing: its cause wasn't named" : "" }, html("span", { "class": "arch-mono" }, message.label), html("span", { "class": "wa-color-text-quiet" }, " " + [...message.path.slice(0, -1).map((id) => labelOf(store, id)), handledBy(message)].join(" → ") + (count > 1 ? `  ×${count}` : ""))),
			...grouped(message.caused).flatMap((child) => line(child.message, child.count, depth + 1))
		];

		return flows.length === 0
			? [html("p", { "class": "wa-color-text-quiet" }, feature === undefined ? "No flows yet: a flow is a message and the ones it caused, followed by the causes the hub names." : `No ${feature} messages in the recent traffic.`)]
			: [html("p", { "class": "wa-color-text-quiet" }, "Each message and the ones it caused, across hubs, the same shape counted once (×N); dimmed lines are linked by timing, their cause not named."), ...flows.map(({ message, count }) => html("div", { "class": "arch-flow-group" }, ...line(message, count, 0)))];
	}

	function renderLog(): Child[] {
		const rows: HTMLElement[] = [];

		for (let index = store.log.length - 1; index >= 0 && rows.length < 300; index -= 1) {
			const sample = store.log[index];

			if (showAcks || sample.kind !== "ack") {
				const channel = store.channelById(sample.channel);

				if (logFilter.length === 0 || `${sample.label} ${sample.kind} ${channel === undefined ? "" : labelOf(store, channel.a) + " " + labelOf(store, channel.b)}`.toLowerCase().includes(logFilter)) {
					rows.push(sampleRow(sample, channel, true));
				}
			}
		}

		logList.replaceChildren(...rows);

		return [filterInput, logList];
	}

	let panelHovered = false;

	panel.addEventListener("mouseenter", () => {
		panelHovered = true;
	});
	panel.addEventListener("mouseleave", () => {
		panelHovered = false;
	});

	// Created once — rebuilding them every tick would swallow clicks landing mid-rebuild.
	// Tabs only: the one panel below them draws whichever is open.
	const tabButtons = new Map<Tab, HTMLElement>((["inspector", "conformance", "flows", "log"] as Tab[]).map((id) => {
		const element = html("wa-tab", { "panel": id });

		tabs.append(element);

		return [id, element];
	}));

	// With no panels of its own the group emits no wa-tab-show: its choice is read once a click or a key has moved it.
	const chosen = (): void => {
		void tabs.updateComplete.then(() => {
			const id = tabs.active as Tab;

			if (id !== tab) {
				tab = id;
				refreshPanel(true);
			}
		});
	};

	tabs.addEventListener("click", chosen);
	tabs.addEventListener("keydown", chosen);

	/** The open tab's content: the Inspector's is the selection's, or the overview with none. */
	function panelContent(): Child[] {
		if (tab === "conformance") {
			return renderConformance();
		}

		if (tab === "flows") {
			return renderFlows();
		}

		if (tab === "log") {
			return renderLog();
		}

		if (selection === undefined) {
			return renderOverview();
		}

		return selection.type === "node" ? renderNode(selection.id) : renderEdge(selection.id);
	}

	function refreshPanel(force = false): void {
		const violations = conformance().length;
		const labels: Record<Tab, string> = { "inspector": "Inspector", "conformance": violations > 0 ? `Conformance (${violations})` : "Conformance", "flows": "Flows", "log": "Log" };

		for (const [id, element] of tabButtons) {
			element.textContent = labels[id];
		}

		tabs.active = tab;

		// Don't move content under the mouse unless asked.
		if (!force && (panelHovered || paused)) {
			return;
		}

		const { scrollTop } = panel;
		const content = panelContent();

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
	disposables.push(() => {
		clearInterval(interval);
	}, () => {
		resizeObserver.disconnect();
	});

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
