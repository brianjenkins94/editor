/**
 * Authoring prototype — the WRITE face of the Event Sheet, rendered in the same auxpane as the read Map. You build a game
 * with NEAR-ZERO TYPING: "New game" scaffolds a blank but runnable game; then you PAINT a level on a grid (floor + placed
 * objects, each object a one-click preset that carries its behaviors + sprite) and pick systems from a palette. "Generate"
 * VENDORS the whole game into the game dir (the user owns every file); the Map face re-projects it and, if a dev server is
 * running, HMR shows it run. The model + generator underneath are the real foundation; this is the tactile surface.
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings, webawesome/prefer-components -- a prototype authoring surface in the aux-bar body; intrinsic layout + custom sprite/label paint-tool tiles, not themeable chrome */
import type { AuthoredGame } from "./game-generator";
import { generateGame, libraryComponents, objectPresets, spriteDataUrls } from "./game-generator";
import type { Rule } from "./game-rules";
import { builtinBehaviors } from "./game-rules";

/** Capitalize the first letter (for auto-naming generated rules). */
function capitalize(text: string): string {
	return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A rule/system name not already taken in `rules` (fn names must be unique per game). */
function uniqueName(rules: Rule[], base: string): string {
	const taken = new Set(rules.map((rule) => rule.name));

	if (!taken.has(base)) {
		return base;
	}

	let index = 2;

	while (taken.has(base + index)) {
		index += 1;
	}

	return base + index;
}

const BORDER = "1px solid var(--vscode-panel-border,#2a2a2a)";

/** The active paint tool: "floor" carves walkable area, "erase" clears a cell, or an object preset's type to place it. */
type Tool = string;
// The active tool persists across re-renders (module-level, like the Build/Map mode).
let activeTool: Tool = "floor";

/** Host hooks the auxpane owner provides: re-render this face, and scaffold a new blank game. */
export interface AuthoringHost {
	"rerender": () => void;
	"createGame": (name: string) => Promise<void>;
}

/** Ensure every parent directory of the generated files exists, then write them (zen-fs won't auto-create parents). */
export async function writeGeneratedGame(api: any, root: string, files: Record<string, string>): Promise<void> {
	const encoder = new TextEncoder();
	const dirs = new Set<string>();

	for (const relative of Object.keys(files)) {
		const parts = relative.split("/");

		parts.pop();

		let dir = root;

		for (const part of parts) {
			dir += "/" + part;
			dirs.add(dir);
		}
	}

	for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
		await api.workspace.fs.createDirectory(api.Uri.file(dir));
	}

	for (const [relative, content] of Object.entries(files)) {
		await api.workspace.fs.writeFile(api.Uri.file(root + "/" + relative), encoder.encode(content));
	}
}

/** A small labelled button. */
function button(label: string, onClick: () => void): HTMLElement {
	const element = document.createElement("wa-button");

	element.setAttribute("size", "small");
	element.setAttribute("appearance", "outlined");
	element.textContent = label;
	element.addEventListener("click", onClick);

	return element;
}

/** A removable chip (behavior / system). */
function chip(text: string, onRemove: () => void): HTMLElement {
	const element = document.createElement("span");

	element.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin:2px 4px 2px 0;padding:1px 4px 1px 8px;border-radius:9px;font-size:11px;background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff)";

	const label = document.createElement("span");

	label.textContent = text;

	const close = document.createElement("span");

	close.textContent = "×";
	close.style.cssText = "cursor:pointer;opacity:0.7;font-weight:600";
	close.addEventListener("click", (event) => { event.stopPropagation(); onRemove(); });

	element.append(label, close);

	return element;
}

/** A section heading. */
function heading(text: string): HTMLElement {
	const element = document.createElement("div");

	element.textContent = text;
	element.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;opacity:0.6";

	return element;
}

/**
 * The level grid painter — the heart of the near-zero-typing build. Paints `model.map`: floor cells (walkable; everything
 * else is a wall) and placed object instances. Mouse-drag paints. Placing an object auto-carves floor under it and
 * ensures its entity (with the preset's behaviors) exists so the generated game.ts wires it.
 */
function renderGrid(container: HTMLElement, model: AuthoredGame, rerender: () => void): void {
	const map = model.map;

	if (map === undefined) {
		return;
	}

	const sprites = spriteDataUrls();
	const presets = new Map(objectPresets().map((preset) => [preset.type, preset]));
	const cell = 16;

	const hasFloor = (x: number, y: number): boolean => map.floor.some(([fx, fy]) => fx === x && fy === y);
	const objectAt = (x: number, y: number) => map.objects.find((object) => object.x === x && object.y === y);

	const carveFloor = (x: number, y: number): void => {
		if (!hasFloor(x, y)) {
			map.floor.push([x, y]);
		}
	};

	const ensureEntity = (type: string): void => {
		const preset = presets.get(type);

		if (preset !== undefined && !model.entities.some((entity) => entity.name === type)) {
			model.entities.push({ "name": type, "components": [...preset.components], "depth": preset.depth });
		}
	};

	const paintCell = (x: number, y: number): void => {
		if (activeTool === "floor") {
			carveFloor(x, y);
		} else if (activeTool === "erase") {
			map.floor = map.floor.filter(([fx, fy]) => fx !== x || fy !== y);
			map.objects = map.objects.filter((object) => object.x !== x || object.y !== y);
		} else {
			// An object tool: carve floor under it, keep one object per cell, singleton the player, wire the entity.
			carveFloor(x, y);
			map.objects = map.objects.filter((object) => object.x !== x || object.y !== y);

			if (activeTool === "player") {
				map.objects = map.objects.filter((object) => object.type !== "player");
			}

			map.objects.push({ "type": activeTool, "x": x, "y": y });
			ensureEntity(activeTool);
		}
	};

	// ── tool palette ───────────────────────────────────────────────────────────
	const palette = document.createElement("div");

	palette.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding:4px 10px 8px";

	const tools: { "tool": Tool; "label": string; "sprite"?: string }[] = [
		{ "tool": "floor", "label": "Floor", "sprite": "gray_square" },
		...objectPresets().map((preset) => ({ "tool": preset.type as Tool, "label": preset.type, "sprite": preset.sprite })),
		{ "tool": "erase", "label": "Erase" }
	];

	const selectTool = (tool: Tool): void => { activeTool = tool; rerender(); };

	for (const entry of tools) {
		const item = document.createElement("button");
		const selected = activeTool === entry.tool;

		item.type = "button";
		item.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:11px;cursor:pointer;border:" + (selected ? "1px solid var(--vscode-focusBorder,#0a84ff)" : BORDER) + ";background:" + (selected ? "var(--vscode-list-activeSelectionBackground,#094771)" : "transparent") + ";color:inherit";

		if (entry.sprite !== undefined && sprites[entry.sprite] !== undefined) {
			const icon = document.createElement("img");

			icon.src = sprites[entry.sprite];
			icon.style.cssText = "width:14px;height:14px;image-rendering:pixelated";
			item.append(icon);
		}

		const text = document.createElement("span");

		text.textContent = entry.label;
		item.append(text);
		item.addEventListener("click", () => { selectTool(entry.tool); });
		palette.append(item);
	}

	container.append(palette);

	// ── the grid ───────────────────────────────────────────────────────────────
	const scroll = document.createElement("div");

	scroll.style.cssText = "overflow:auto;padding:0 10px 8px";

	const grid = document.createElement("div");

	grid.style.cssText = "display:grid;grid-template-columns:repeat(" + map.width + "," + cell + "px);grid-template-rows:repeat(" + map.height + "," + cell + "px);width:max-content;background:#000;border:" + BORDER;

	for (let y = 0; y < map.height; y++) {
		for (let x = 0; x < map.width; x++) {
			const box = document.createElement("div");
			const floor = hasFloor(x, y);

			box.dataset.x = String(x);
			box.dataset.y = String(y);
			box.style.cssText = "width:" + cell + "px;height:" + cell + "px;box-sizing:border-box;background-size:cover;image-rendering:pixelated;background-image:url(" + (floor ? sprites.gray_square : sprites.wall_block) + ")";

			const object = objectAt(x, y);

			if (object !== undefined && sprites[presets.get(object.type)?.sprite ?? object.type] !== undefined) {
				const img = document.createElement("img");

				img.src = sprites[presets.get(object.type)?.sprite ?? object.type];
				img.draggable = false;
				img.style.cssText = "width:100%;height:100%;image-rendering:pixelated;pointer-events:none";
				box.append(img);
			}

			grid.append(box);
		}
	}

	// Mouse-drag painting via delegation (one set of listeners, no per-cell closures / no-loop-func).
	let painting = false;

	const cellAt = (target: EventTarget | null): [number, number] | undefined => {
		const element = (target as HTMLElement | null)?.closest?.("[data-x]") as HTMLElement | null;

		if (element?.dataset.x === undefined || element.dataset.y === undefined) {
			return undefined;
		}

		return [Number(element.dataset.x), Number(element.dataset.y)];
	};

	grid.addEventListener("mousedown", (event) => {
		const coordinate = cellAt(event.target);

		if (coordinate === undefined) {
			return;
		}

		painting = true;
		paintCell(coordinate[0], coordinate[1]);
		rerender();
	});

	grid.addEventListener("mouseover", (event) => {
		if (!painting) {
			return;
		}

		const coordinate = cellAt(event.target);

		if (coordinate !== undefined) {
			paintCell(coordinate[0], coordinate[1]);
			rerender();
		}
	});

	// Stop painting anywhere the mouse comes up (window, so a release outside the grid still ends the stroke).
	const stop = (): void => { painting = false; };

	window.addEventListener("mouseup", stop, { "once": true });

	scroll.append(grid);
	container.append(scroll);
}

/** Render the authoring editor for `model` into `container`; edits mutate the model and call `host.rerender`. */
export function renderAuthoring(container: HTMLElement, api: any, root: string, model: AuthoredGame, host: AuthoringHost): void {
	const rerender = host.rerender;

	container.replaceChildren();
	container.style.cssText = "height:100%;overflow:auto;padding-bottom:12px";

	// ── toolbar ──────────────────────────────────────────────────────────────────
	const toolbar = document.createElement("div");

	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:" + BORDER;

	const generate = button("Generate", () => {
		void (async (): Promise<void> => {
			const files = generateGame(model);

			await writeGeneratedGame(api, root, files);
			api.window.showInformationMessage?.("Vendored " + Object.keys(files).length + " files into " + (root.split("/").pop() ?? root));
		})();
	});

	generate.setAttribute("variant", "brand");

	const newGame = button("New game", () => {
		void (async (): Promise<void> => {
			const chosen = await api.window.showInputBox({ "title": "New game", "prompt": "Name — scaffolds a blank runnable game you own, then paint it in Build" });

			if (typeof chosen === "string" && chosen.trim() !== "") {
				await host.createGame(chosen.trim());
			}
		})();
	});

	toolbar.append(generate, newGame);
	container.append(toolbar);

	// ── level painter ──────────────────────────────────────────────────────────────
	if (model.map !== undefined) {
		container.append(heading("LEVEL"));
		renderGrid(container, model, rerender);
	}

	// ── objects (entity types + their behaviors) ─────────────────────────────────────
	const objectsHeading = document.createElement("div");

	objectsHeading.textContent = "OBJECTS";
	objectsHeading.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;opacity:0.6;border-top:" + BORDER;
	container.append(objectsHeading);

	if (model.entities.length === 0) {
		const empty = document.createElement("div");

		empty.textContent = "Pick an object tool above and paint it onto the grid.";
		empty.style.cssText = "padding:2px 10px 6px;font-size:11px;opacity:0.5";
		container.append(empty);
	}

	for (const entity of model.entities) {
		const card = document.createElement("div");

		card.style.cssText = "padding:6px 10px;border-bottom:" + BORDER;

		const header = document.createElement("div");

		header.style.cssText = "display:flex;align-items:center;gap:6px";

		const name = document.createElement("span");

		name.textContent = entity.name;
		name.style.cssText = "font-weight:600";

		const remove = document.createElement("span");

		remove.textContent = "×";
		remove.style.cssText = "cursor:pointer;opacity:0.5;margin-left:auto";
		remove.addEventListener("click", () => {
			model.entities = model.entities.filter((other) => other !== entity);

			if (model.map !== undefined) {
				model.map.objects = model.map.objects.filter((object) => object.type !== entity.name);
			}

			rerender();
		});

		header.append(name, remove);
		card.append(header);

		const chips = document.createElement("div");

		chips.style.cssText = "margin-top:4px";

		for (const behavior of entity.components) {
			chips.append(chip(behavior, () => {
				entity.components = entity.components.filter((other) => other !== behavior);
				rerender();
			}));
		}

		const addBehavior = document.createElement("span");

		addBehavior.textContent = "＋ behavior";
		addBehavior.style.cssText = "cursor:pointer;font-size:11px;opacity:0.6;margin-left:2px";
		addBehavior.addEventListener("click", () => {
			void (async (): Promise<void> => {
				const options = libraryComponents().filter((component) => component !== "Position" && !entity.components.includes(component));
				const picked = await api.window.showQuickPick(options, { "title": "Add behavior to " + entity.name });

				if (typeof picked === "string") {
					entity.components.push(picked);
					rerender();
				}
			})();
		});

		chips.append(addBehavior);
		card.append(chips);
		container.append(card);
	}

	// ── rules (the game's logic: event-sheet rows composed from behaviors) ─────────────
	// Adding a rule puts the game on the COMPOSED path (Generate compiles these to systems; see game-generator). We only
	// define model.rules once the user actually adds one, so Generate over an as-yet-unauthored game keeps its old path.
	const rules = model.rules ?? [];
	const addRuleTo = (rule: Rule): void => { model.rules = [...rules, rule]; rerender(); };
	const entityNames = model.entities.map((entity) => entity.name);
	const subjectOf = (name: string): string | undefined => model.entities.find((entity) => entity.name === name)?.components[0];

	const rulesHeading = document.createElement("div");

	rulesHeading.textContent = "RULES";
	rulesHeading.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;opacity:0.6;border-top:" + BORDER;
	container.append(rulesHeading);

	if (rules.length === 0) {
		const empty = document.createElement("div");

		empty.textContent = entityNames.length === 0 ? "Paint some objects first, then add rules." : "Add a rule: pick when it happens and what it does.";
		empty.style.cssText = "padding:2px 10px 6px;font-size:11px;opacity:0.5";
		container.append(empty);
	}

	for (const rule of rules) {
		const card = document.createElement("div");

		card.style.cssText = "padding:6px 10px;border-bottom:" + BORDER + ";display:flex;align-items:center;gap:6px";

		const text = document.createElement("span");

		text.style.cssText = "font-size:12px";

		if (rule.kind === "aggregate") {
			text.textContent = "Win when every " + rule.allOn + " is on a " + rule.goal;
		} else {
			const uses = rule.body.flatMap((statement) => ("use" in statement ? [statement.use] : []));

			text.textContent = "When " + (rule.on === "keyDirection" ? "a key is pressed" : "every tick") + " · for each " + rule.subject + (uses.length > 0 ? " → " + uses.join(", ") : "");
		}

		const remove = document.createElement("span");

		remove.textContent = "×";
		remove.style.cssText = "cursor:pointer;opacity:0.5;margin-left:auto";
		remove.addEventListener("click", () => {
			model.rules = rules.filter((other) => other !== rule);
			rerender();
		});

		card.append(text, remove);
		container.append(card);
	}

	const addRule = document.createElement("div");

	addRule.style.cssText = "padding:6px 10px";
	addRule.append(button("＋ Rule", () => {
		void (async (): Promise<void> => {
			const when = await api.window.showQuickPick(["When a key is pressed", "Every tick", "Win when…"], { "title": "Add a rule" });

			if (typeof when !== "string") {
				return;
			}

			if (when === "Win when…") {
				const these = await api.window.showQuickPick(entityNames, { "title": "Win when every…" });
				const goals = typeof these === "string" ? await api.window.showQuickPick(entityNames, { "title": "…is standing on a…" }) : undefined;
				const allOn = subjectOf(these ?? "");
				const goal = subjectOf(goals ?? "");

				if (allOn !== undefined && goal !== undefined) {
					addRuleTo({ "kind": "aggregate", "name": uniqueName(rules, "winSystem"), "on": "step", "allOn": allOn, "goal": goal });
				}

				return;
			}

			const subjectName = await api.window.showQuickPick(entityNames, { "title": "For each…" });
			const subject = subjectOf(subjectName ?? "");

			if (subject === undefined) {
				return;
			}

			const behavior = await api.window.showQuickPick(builtinBehaviors().map((entry) => entry.name), { "title": "Do what?" });

			if (typeof behavior === "string") {
				addRuleTo({ "kind": "perEntity", "name": uniqueName(rules, (subjectName ?? "each") + capitalize(behavior)), "subject": subject, "on": when === "When a key is pressed" ? "keyDirection" : "step", "body": [{ "use": behavior }] });
			}
		})();
	}));
	container.append(addRule);

	// ── behaviors (the reusable library rules compose) ─────────────────────────────────
	const behaviorsHeading = document.createElement("div");

	behaviorsHeading.textContent = "BEHAVIORS";
	behaviorsHeading.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;opacity:0.6;border-top:" + BORDER;
	container.append(behaviorsHeading);

	const behaviorList = document.createElement("div");

	behaviorList.style.cssText = "padding:2px 10px 8px";

	for (const behavior of builtinBehaviors()) {
		const badge = document.createElement("span");

		badge.textContent = behavior.name;
		badge.style.cssText = "display:inline-block;margin:2px 4px 2px 0;padding:1px 8px;border-radius:9px;font-size:11px;background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff)";
		behaviorList.append(badge);
	}

	const behaviorNote = document.createElement("div");

	behaviorNote.textContent = "Reusable behaviors built from primitives — composed by rules. After Generate, open one to see there's no magic.";
	behaviorNote.style.cssText = "padding:4px 10px 0;font-size:11px;opacity:0.5";
	behaviorList.append(behaviorNote);
	container.append(behaviorList);
}
