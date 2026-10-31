/**
 * The features map (a side bar of its own, core's): the program as its features, the way WinDirStat draws a disk, in
 * the Insights monitor's cards. A card per area of the feature manifest (packages/silo/README.md, *The feature
 * manifest*), largest first, with its share of the program's code; in it, a block per feature, sized by the code it owns
 * (code several features own split between them, so the blocks add up to the program; what no feature owns has a card
 * of its own), and a legend of them in their blocks' colors. A block's tooltip says what the feature does, its files,
 * how much of its code is its alone, and its tests. Click a block or its name to focus on the feature — the rest of the
 * workspace steps back (History's: the Explorer's dots, open editors dimmed, its name in the status bar) — and again to
 * show every feature.
 *
 * What it draws is History's reading of the program (extensions/history/features.ts), asked for through
 * `history.features` while it shows: by the revision it has, so it's redrawn only when the reading changed. Plain
 * DOM/SVG in the workbench realm (a custom view, not a webview); the cards are the monitor's (theme/styles/
 * insights-monitor), the blocks theme/styles/features-map.
 */
import type * as vscodeApi from "vscode";
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";
import { caption } from "theme/recipes";
import { featuresMapStyles } from "theme/styles/features-map";
import { insightsMonitorStyles } from "theme/styles/insights-monitor";
import "theme/components/card";

const SVG_NS = "http://www.w3.org/2000/svg";
/** How often the map asks whether the reading changed, while it shows. */
const POLL_MS = 2000;
/** A card's chart's height, and how many colors its blocks take in turn (the Insights monitor's series colors). */
const HEIGHT = 64;
const COLORS = 6;
/** How far a card's chart is inset from the view's edge: the view's padding, the card's border and its spacing. */
const CARD_INSET = 22;
/** The activity bar's icon: blocks of a treemap. */
const ICON = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5'><rect x='3' y='3' width='10' height='11'/><rect x='13' y='3' width='8' height='6'/><rect x='13' y='9' width='8' height='12'/><rect x='3' y='14' width='10' height='7'/></svg>")}`;

/** What `history.features` answers. */
interface Reading {
	"revision": number;
	"message"?: string;
	"features"?: { "area": string; "name": string; "what": string; "status"?: string; "tests": { "outcome": string }[] }[];
	"code"?: { "file": string; "start": number; "end": number; "owners": number[] }[];
	"focused"?: number;
}

/** A block: a feature (by index), or the code no feature owns (-1); its size, its own share, its files. */
interface Block { "index": number; "size": number; "own": number; "files": number }

/** The worst aspect ratio of a row of areas laid along a side (squarified treemaps: Bruls, Huizing and van Wijk). */
function worst(row: number[], side: number): number {
	const sum = row.reduce((total, area) => total + area, 0);

	return Math.max(side * side * Math.max(...row) / (sum * sum), sum * sum / (side * side * Math.min(...row)));
}

/** Lay `items` out in a rectangle, each by its size, in rows as square as they'll go. */
function squarify<T>(items: { "item": T; "size": number }[], x: number, y: number, width: number, height: number): { "item": T; "x": number; "y": number; "width": number; "height": number }[] {
	const total = items.reduce((sum, each) => sum + each.size, 0);
	const placed: { "item": T; "x": number; "y": number; "width": number; "height": number }[] = [];

	if (total <= 0 || width <= 0 || height <= 0) {
		return placed;
	}

	let rest = items.toSorted((left, right) => right.size - left.size).map((each) => ({ "item": each.item, "area": each.size * width * height / total }));

	while (rest.length > 0) {
		const side = Math.min(width, height);
		let count = 1;

		while (count < rest.length && worst(rest.slice(0, count + 1).map((each) => each.area), side) <= worst(rest.slice(0, count).map((each) => each.area), side)) {
			count += 1;
		}

		const row = rest.slice(0, count);
		const sum = row.reduce((total, each) => total + each.area, 0);
		const depth = sum / (width >= height ? height : width);
		let at = width >= height ? y : x;

		for (const each of row) {
			const length = each.area / depth;

			placed.push(width >= height ? { "item": each.item, "x": x, "y": at, "width": depth, "height": length } : { "item": each.item, "x": at, "y": y, "width": length, "height": depth });
			at += length;
		}

		if (width >= height) {
			x += depth;
			width -= depth;
		} else {
			y += depth;
			height -= depth;
		}

		rest = rest.slice(count);
	}

	return placed;
}

/** Each feature's block, and the code no feature owns. */
function blocksOf(reading: Reading): Block[] {
	const blocks = new Map<number, { "size": number; "own": number; "files": Set<string> }>();

	for (const code of reading.code ?? []) {
		const size = Math.max(code.end - code.start, 1);

		for (const owner of code.owners.length === 0 ? [-1] : code.owners) {
			const block = blocks.get(owner) ?? blocks.set(owner, { "size": 0, "own": 0, "files": new Set() }).get(owner)!;

			block.size += size / Math.max(code.owners.length, 1);
			block.own += code.owners.length <= 1 ? size : 0;
			block.files.add(code.file);
		}
	}

	return [...blocks].map(([index, block]) => ({ "index": index, "size": block.size, "own": block.own / Math.max(block.size, 1), "files": block.files.size }));
}

export function registerFeaturesMap(vscode: typeof vscodeApi): void {
	registerCustomView({
		"id": "features.map",
		"name": "Features",
		"icon": ICON,
		"location": ViewContainerLocation.Sidebar,
		"renderBody": (container: HTMLElement) => {
			let reading: Reading = { "revision": -1 };
			let disposed = false;
			const root = document.createElement("div");

			insightsMonitorStyles();
			featuresMapStyles();
			root.className = "monitor fm-root wa-stack wa-gap-s";
			container.append(root);

			const run = async <T>(command: string, ...rest: unknown[]): Promise<T | undefined> => Promise.resolve(vscode.commands.executeCommand<T>(command, ...rest)).catch(() => undefined);
			const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), { "className": className, ...properties });
			const percent = (part: number, whole: number): string => `${String(Math.round(100 * part / Math.max(whole, 1)))}%`;
			/** Focus on a feature, or, focused already, show every feature. */
			const toggle = (index: number): void => {
				void run(index === reading.focused ? "history.features.unfocus" : "history.features.focus", index).then(poll);
			};

			/** A card per area, largest first, as the Insights monitor draws its cards: the area and its share of the
			 *  program's code; a block per feature, sized by its code; and a legend of them, each in its block's color. */
			function draw(): void {
				const blocks = blocksOf(reading);
				// Laid out at the cards' width now, so the blocks are as square as they're drawn.
				const width = Math.max(root.clientWidth - 2 * CARD_INSET, 100);
				const total = blocks.reduce((sum, block) => sum + block.size, 0);
				const areas = new Map<string, Block[]>();

				for (const block of blocks.toSorted((left, right) => right.size - left.size)) {
					const area = block.index < 0 ? "No feature" : reading.features?.[block.index]?.area ?? "";

					areas.set(area, [...areas.get(area) ?? [], block]);
				}

				const cards = [...areas].toSorted(([, left], [, right]) => right.reduce((sum, block) => sum + block.size, 0) - left.reduce((sum, block) => sum + block.size, 0)).map(([area, ofArea]) => {
					const card = element("wa-card", "monitor-card", { "appearance": "outlined" });
					const head = element("div", "wa-split " + caption());
					const chart = document.createElementNS(SVG_NS, "svg");
					const legend = element("div", "wa-cluster wa-gap-xs wa-font-size-s");
					const size = ofArea.reduce((sum, block) => sum + block.size, 0);

					head.append(element("span", "", { "textContent": area }), element("span", "", { "textContent": percent(size, total) }));
					chart.setAttribute("class", "fm-chart");
					chart.setAttribute("viewBox", `0 0 ${String(width)} ${String(HEIGHT)}`);
					chart.setAttribute("preserveAspectRatio", "none");

					for (const placed of squarify(ofArea.map((block, order) => ({ "item": { "block": block, "order": order }, "size": block.size })), 0, 0, width, HEIGHT)) {
						const { block, order } = placed.item;
						const feature = block.index < 0 ? undefined : reading.features?.[block.index];
						const rect = document.createElementNS(SVG_NS, "rect");
						const title = document.createElementNS(SVG_NS, "title");
						const failing = feature?.tests.filter((test) => test.outcome === "fail").length ?? 0;

						rect.setAttribute("class", `${block.index < 0 ? "fm-none" : `monitor-line-${String(order % COLORS)}`}${block.index === reading.focused ? " fm-focused" : ""}`);
						rect.setAttribute("x", placed.x.toFixed(2));
						rect.setAttribute("y", placed.y.toFixed(2));
						rect.setAttribute("width", placed.width.toFixed(2));
						rect.setAttribute("height", placed.height.toFixed(2));
						title.textContent = feature === undefined
							? `Code no feature of the manifest owns, in ${String(block.files)} files.`
							: `${feature.name}${feature.status === undefined ? "" : ` (${feature.status})`}: ${feature.what}\n${String(block.files)} file${block.files === 1 ? "" : "s"}, ${percent(block.own, 1)} of its code its own; ${String(feature.tests.length)} test${feature.tests.length === 1 ? "" : "s"}${failing === 0 ? "" : `, ${String(failing)} failing`}.`;
						rect.append(title);

						if (block.index >= 0) {
							rect.addEventListener("click", () => {
								toggle(block.index);
							});
						}

						chart.append(rect);
					}

					for (const [order, block] of ofArea.entries()) {
						const name = block.index < 0 ? `${String(block.files)} files` : reading.features?.[block.index]?.name ?? "";
						const label = element("span", `${block.index < 0 ? "fm-none" : `monitor-line-${String(order % COLORS)}`}${block.index === reading.focused ? " fm-focused" : ""}`, { "textContent": `${name} ${percent(block.size, total)}` });

						if (block.index >= 0) {
							label.addEventListener("click", () => {
								toggle(block.index);
							});
						}

						legend.append(label);
					}

					card.append(head, chart, legend);

					return card;
				});

				root.replaceChildren(...cards.length === 0 ? [element("p", "wa-color-text-quiet", { "textContent": reading.message ?? "Reading the program…" })] : cards);
			}

			async function poll(): Promise<void> {
				const answer = await run<Reading>("history.features", { "since": reading.revision });

				if (disposed || answer === undefined) {
					return;
				}

				const changed = answer.code !== undefined || answer.focused !== reading.focused;

				reading = { ...answer.code === undefined ? reading : answer, "revision": answer.revision };

				if (answer.focused === undefined) {
					delete reading.focused;
				} else {
					reading.focused = answer.focused;
				}

				if (changed) {
					draw();
				}
			}

			// Redrawn a frame after the side bar's width changes (not inside the observer's callback, which drawing would
			// call again: "ResizeObserver loop completed with undelivered notifications").
			let width = 0;
			const resized = new ResizeObserver(() => {
				requestAnimationFrame(() => {
					if (!disposed && root.clientWidth !== width) {
						width = root.clientWidth;
						draw();
					}
				});
			});
			const timer = setInterval(() => {
				if (root.isConnected && root.offsetParent !== null) {
					void poll();
				}
			}, POLL_MS);

			resized.observe(root);
			void poll();

			return {
				"dispose": () => {
					disposed = true;
					clearInterval(timer);
					resized.disconnect();
					root.remove();
				}
			};
		}
	});
}
