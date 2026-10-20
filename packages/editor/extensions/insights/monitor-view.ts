/**
 * The monitor's view — the script of its webview (monitor.ts serves it): the metrics plane as sparkline cards, the last
 * two minutes of each series. Web Awesome on the VS Code theme (theme/vscode); the cards' charts are plain SVG
 * polylines, one per series, in the palette's colours (theme/exceptions/insights-monitor.css).
 */
import css from "theme/exceptions/insights-monitor.css?raw";
import { followVsCodeTheme } from "theme/vscode";
import "@awesome.me/webawesome/dist/components/card/card.js";

/** `source:name` → [t, value] points, oldest first (monitor.ts keeps them). */
export type Series = Record<string, [number, number][]>;

/** What the extension posts: every series, each second. */
export interface MonitorMessage { "series": Series }

/** A card the editor declares: the series whose key `match`es (its first group names the line), the `top` few by their
 *  latest value, only those ever above zero (`nonzero`), on a fixed scale (`max`). */
interface Card { "title": string; "match": RegExp; "name"?: (matched: string) => string; "top"?: number; "max"?: number; "nonzero"?: boolean }

/** A line on a card: its name and points. */
interface Line { "name": string; "points": [number, number][] }

/** How many line colours there are (insights-monitor.css: `.monitor-line-0` …). */
const COLORS = 6;
const WINDOW = 120_000;
const SVG = "http://www.w3.org/2000/svg";

const CARDS: Card[] = [
	{ "title": "Memory · MB", "match": /^workbench:memory\.(.+)$/u, "top": 6 },
	{ "title": "Workspace · MB used", "match": /^workbench:workspace\.(usedMB)$/u, "name": () => "used" },
	{ "title": "Long frames · %", "match": /^(\w+):longFrames$/u, "max": 100 },
	{ "title": "Hub · messages/s", "match": /^workbench:(hub)$/u, "name": () => "workbench hub" },
	{ "title": "Storage · MB", "match": /^workbench:(storage)$/u, "name": () => "origin" },
	{ "title": "Spans · p95 ms", "match": /^root:spans\.(.+)\.p95$/u, "top": 6 },
	{ "title": "Spans · ended/s", "match": /^root:spans\.(.+)\.rate$/u, "top": 6 },
	{ "title": "Span errors · last 10 s", "match": /^root:spans\.(.+)\.errors$/u, "top": 6, "nonzero": true }
];

/** The editor's own sources; any other is an app's (a preview's, named under its window: `preview:5180/client-0`). */
const EDITOR = new Set(["workbench", "shell", "root"]);

const format = (value: number): string => (value >= 100 ? value.toFixed(0) : value.toFixed(1));

/** An element of `tag` with `className` and `properties`. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), { "className": className, ...properties });
}

/** A card of `lines` since `from`: its title and scale, a polyline per line, and a legend of their latest values. */
function drawCard(title: string, lines: Line[], from: number, fixed?: number): HTMLElement | undefined {
	if (lines.length === 0) {
		return undefined;
	}

	const max = fixed ?? Math.max(1, ...lines.flatMap((line) => line.points.map((point) => point[1]))) * 1.1;
	const card = element("wa-card", "monitor-card", { "appearance": "outlined" });
	const head = element("div", "wa-split wa-font-size-s wa-text-uppercase wa-color-text-quiet monitor-head");
	const chart = document.createElementNS(SVG, "svg");
	const legend = element("div", "wa-cluster wa-gap-xs wa-font-size-s");

	head.append(element("span", "", { "textContent": title }), element("span", "", { "textContent": "max " + format(fixed ?? max / 1.1) }));
	chart.setAttribute("class", "monitor-chart");
	chart.setAttribute("viewBox", "0 0 100 56");
	chart.setAttribute("preserveAspectRatio", "none");

	lines.forEach((line, index) => {
		const color = `monitor-line-${index % COLORS}`;
		const polyline = document.createElementNS(SVG, "polyline");

		polyline.setAttribute("class", color);
		polyline.setAttribute("points", line.points.filter((point) => point[0] >= from).map((point) => ((point[0] - from) / 1200).toFixed(1) + "," + (56 - (point[1] / max) * 54).toFixed(1)).join(" "));
		chart.append(polyline);
		legend.append(element("span", color, { "textContent": line.name + " " + format(line.points.at(-1)?.[1] ?? 0) }));
	});

	card.append(head, chart, legend);

	return card;
}

/** An app's gauges, with no card of their own to declare: one card per app and gauge (`fps`, `lag`), a line per source
 *  and key — so a game's FPS draws one line per client window, its lag one per client. */
function appCards(series: Series, from: number): HTMLElement[] {
	const cards = new Map<string, Line[]>();

	for (const [key, points] of Object.entries(series)) {
		const at = key.lastIndexOf(":"); // a source can have a colon (`preview:5180`); a gauge's name can't
		const source = key.slice(0, at);
		const name = key.slice(at + 1);

		if (EDITOR.has(source)) {
			continue;
		}

		const slash = source.indexOf("/");
		const app = slash === -1 ? source : source.slice(0, slash);
		const dot = name.indexOf(".");
		const gauge = dot === -1 ? name : name.slice(0, dot);
		const title = gauge + " · " + app;
		const line = [slash === -1 ? "" : source.slice(slash + 1), dot === -1 ? "" : name.slice(dot + 1)].filter(Boolean).join(" ") || app;

		cards.set(title, [...cards.get(title) ?? [], { "name": line, "points": points }]);
	}

	return [...cards].toSorted(([left], [right]) => left.localeCompare(right)).flatMap(([title, lines]) => drawCard(title, lines.toSorted((left, right) => left.name.localeCompare(right.name)), from) ?? []);
}

/** Every card, for `series` now. */
function render(container: HTMLElement, series: Series): void {
	const now = Math.max(0, ...Object.values(series).map((points) => points.at(-1)?.[0] ?? 0));
	const from = now - WINDOW;
	const cards = CARDS.flatMap((card) => {
		let lines = Object.entries(series).flatMap(([key, points]): Line[] => {
			const matched = card.match.exec(key);

			return matched === null ? [] : [{ "name": card.name === undefined ? matched[1] : card.name(matched[1]), "points": points }];
		}).toSorted((left, right) => (right.points.at(-1)?.[1] ?? 0) - (left.points.at(-1)?.[1] ?? 0));

		if (card.nonzero === true) {
			lines = lines.filter((line) => line.points.some((point) => point[1] > 0));
		}

		if (card.top !== undefined) {
			lines = lines.slice(0, card.top);
		}

		return drawCard(card.title, lines, from, card.max) ?? [];
	});

	container.replaceChildren(...cards, ...appCards(series, from));

	if (container.childElementCount === 0) {
		container.append(waiting());
	}
}

function waiting(): HTMLElement {
	return element("p", "wa-color-text-quiet", { "textContent": "Waiting for metrics…" });
}

function start(): void {
	const container = element("div", "monitor wa-stack wa-gap-s");

	// Web Awesome on the VS Code theme (theme/vscode, as in the workbench), then what it doesn't cover.
	document.head.append(element("style", "", { "textContent": css }));
	followVsCodeTheme(document.body);
	container.append(waiting());
	document.body.replaceChildren(container);

	window.addEventListener("message", (event: MessageEvent<MonitorMessage | undefined>) => {
		if (event.data?.series !== undefined) {
			render(container, event.data.series);
		}
	});
}

start();
