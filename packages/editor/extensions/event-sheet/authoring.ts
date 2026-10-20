/**
 * Authoring prototype — the WRITE face of the Event Sheet (Build), beside the read face (Map) in its view. You build a game
 * with NEAR-ZERO TYPING: "New game" scaffolds a blank but runnable game; then you PAINT a level on a grid (floor + placed
 * objects, each object a one-click preset that carries its behaviors + sprite) and pick systems from a palette. "Generate"
 * VENDORS the whole game into the game dir (the user owns every file); the Map face re-projects it and, if a dev server is
 * running, HMR shows it run. The model + generator underneath are the real foundation; this is the tactile surface.
 */
import type WaButton from "theme/components/button";
import type { AuthoredGame } from "./generator";
import type { Rule } from "./rules";
import type { EventSheetHost } from "./view";
import { generateGame, libraryComponents, objectPresets, spriteDataUrls } from "./generator";
import { builtinBehaviors } from "./rules";
import "theme/components/button";
import "theme/components/tag";

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

/** The active paint tool: "floor" carves walkable area, "erase" clears a cell, or an object preset's type to place it. */
type Tool = string;
// The active tool persists across re-renders (module-level, like the Build/Map mode).
let activeTool: Tool = "floor";

/** What the view gives this face: re-render it, and scaffold a new blank game. */
export interface AuthoringHooks {
	"rerender": () => void;
	"createGame": (name: string) => Promise<void>;
}

/** An element of `tag` with `className` and `properties`. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), { "className": className, ...properties });
}

/** A small labelled button, in VS Code's colors (`primary`: the main action, VS Code's primary button). */
export function button(label: string, onClick: () => void, primary = false): WaButton {
	const made = element("wa-button", "", { "size": "s", "variant": primary ? "brand" : "neutral", "textContent": label });

	made.addEventListener("click", onClick);

	return made;
}

/** A borderless button: a small action beside what it acts on (× to remove, ＋ to add). */
function plainButton(label: string, title: string, onClick: () => void): WaButton {
	const made = element("wa-button", "", { "size": "s", "appearance": "plain", "textContent": label, "title": title });

	made.addEventListener("click", onClick);

	return made;
}

/** A behavior or system, as a tag — removable, with `onRemove`. */
export function chip(text: string, onRemove?: () => void): HTMLElement {
	const made = element("wa-tag", "", { "size": "s", "pill": true, "textContent": text, "withRemove": onRemove !== undefined });

	if (onRemove !== undefined) {
		made.addEventListener("wa-remove", (event) => {
			event.stopPropagation();
			onRemove();
		});
	}

	return made;
}

/** A section heading; `divided`, ruled off from the section above. */
export function heading(text: string, divided = false): HTMLElement {
	return element("div", `event-sheet-heading${divided ? " divided" : ""} app-caption`, { "textContent": text });
}

/** A quiet note: what's empty, or what a section is. */
function note(text: string): HTMLElement {
	return element("div", "event-sheet-section wa-caption-xs wa-color-text-quiet", { "textContent": text });
}

/**
 * The level grid painter — the heart of the near-zero-typing build. Paints `model.map`: floor cells (walkable; everything
 * else is a wall) and placed object instances. Mouse-drag paints. Placing an object auto-carves floor under it and
 * ensures its entity (with the preset's behaviors) exists so the generated game.ts wires it.
 */
function renderGrid(container: HTMLElement, model: AuthoredGame, rerender: () => void): void {
	const { map } = model;

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
	const palette = element("div", "event-sheet-section wa-cluster wa-gap-2xs");

	const tools: { "tool": Tool; "label": string; "sprite"?: string }[] = [
		{ "tool": "floor", "label": "Floor", "sprite": "gray_square" },
		...objectPresets().map((preset) => ({ "tool": preset.type, "label": preset.type, "sprite": preset.sprite })),
		{ "tool": "erase", "label": "Erase" }
	];

	const selectTool = (tool: Tool): void => {
		activeTool = tool;
		rerender();
	};

	for (const entry of tools) {
		// (the tool in hand is the brand's; the rest, outlined)
		const item = element("wa-button", "", { "size": "s", ...activeTool === entry.tool ? { "variant": "brand" } : { "appearance": "outlined" }, "textContent": entry.label });

		if (entry.sprite !== undefined && sprites[entry.sprite] !== undefined) {
			item.prepend(element("img", "event-sheet-sprite", { "src": sprites[entry.sprite], "slot": "start", "alt": "" }));
		}

		item.addEventListener("click", () => {
			selectTool(entry.tool);
		});
		palette.append(item);
	}

	container.append(palette);

	// ── the grid ───────────────────────────────────────────────────────────────
	const scroll = element("div", "event-sheet-section event-sheet-scroll");
	const grid = element("div", "event-sheet-grid");

	// The level's size and its two tiles (event-sheet.css draws the grid from them).
	grid.style.setProperty("--columns", String(map.width));
	grid.style.setProperty("--rows", String(map.height));
	grid.style.setProperty("--cell", `${cell}px`);
	grid.style.setProperty("--floor", `url(${sprites.gray_square})`);
	grid.style.setProperty("--wall", `url(${sprites.wall_block})`);

	for (let y = 0; y < map.height; y++) {
		for (let x = 0; x < map.width; x++) {
			const box = element("div", hasFloor(x, y) ? "floor" : "");

			box.dataset.x = String(x);
			box.dataset.y = String(y);

			const object = objectAt(x, y);

			if (object !== undefined && sprites[presets.get(object.type)?.sprite ?? object.type] !== undefined) {
				box.append(element("img", "", { "src": sprites[presets.get(object.type)?.sprite ?? object.type], "draggable": false, "alt": object.type }));
			}

			grid.append(box);
		}
	}

	// Mouse-drag painting via delegation (one set of listeners, no per-cell closures / no-loop-func).
	let painting = false;

	const cellAt = (target: EventTarget | null): [number, number] | undefined => {
		const element = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-x]");

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
	const stop = (): void => {
		painting = false;
	};

	window.addEventListener("mouseup", stop, { "once": true });

	scroll.append(grid);
	container.append(scroll);
}

/** Render the authoring editor for `model` into `container`; edits mutate the model and call `host.rerender`. */
export function renderAuthoring(container: HTMLElement, host: EventSheetHost, root: string, model: AuthoredGame, hooks: AuthoringHooks): void {
	const { rerender } = hooks;

	container.replaceChildren();

	// ── toolbar ──────────────────────────────────────────────────────────────────
	const toolbar = element("div", "app-toolbar wa-cluster wa-gap-xs");

	const generate = button("Generate", () => {
		void (async (): Promise<void> => {
			const files = generateGame(model);

			await host.writeFiles(root, files);
			host.info("Vendored " + Object.keys(files).length + " files into " + (root.split("/").pop() ?? root));
		})();
	}, true);

	const newGame = button("New game", () => {
		void (async (): Promise<void> => {
			const chosen = await host.input({ "title": "New game", "prompt": "Name — scaffolds a blank runnable game you own, then paint it in Build" });

			if (typeof chosen === "string" && chosen.trim() !== "") {
				await hooks.createGame(chosen.trim());
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
	container.append(heading("OBJECTS", true));

	if (model.entities.length === 0) {
		container.append(note("Pick an object tool above and paint it onto the grid."));
	}

	for (const entity of model.entities) {
		const card = element("div", "event-sheet-card wa-stack wa-gap-2xs");
		const header = element("div", "wa-split");
		const remove = plainButton("×", `Remove ${entity.name}`, () => {
			model.entities = model.entities.filter((other) => other !== entity);

			if (model.map !== undefined) {
				model.map.objects = model.map.objects.filter((object) => object.type !== entity.name);
			}

			rerender();
		});

		header.append(element("span", "wa-font-weight-semibold", { "textContent": entity.name }), remove);
		card.append(header);

		const chips = element("div", "wa-cluster wa-gap-2xs");

		for (const behavior of entity.components) {
			chips.append(chip(behavior, () => {
				entity.components = entity.components.filter((other) => other !== behavior);
				rerender();
			}));
		}

		const addBehavior = plainButton("＋ behavior", `Add a behavior to ${entity.name}`, () => {
			void (async (): Promise<void> => {
				const options = libraryComponents().filter((component) => component !== "Position" && !entity.components.includes(component));
				const picked = await host.pick(options, { "title": "Add behavior to " + entity.name });

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
	const addRuleTo = (rule: Rule): void => {
		model.rules = [...rules, rule];
		rerender();
	};

	const entityNames = model.entities.map((entity) => entity.name);
	const subjectOf = (name: string): string | undefined => model.entities.find((entity) => entity.name === name)?.components[0];

	container.append(heading("RULES", true));

	if (rules.length === 0) {
		container.append(note(entityNames.length === 0 ? "Paint some objects first, then add rules." : "Add a rule: pick when it happens and what it does."));
	}

	for (const rule of rules) {
		const card = element("div", "event-sheet-card wa-split");
		const text = element("span", "wa-font-size-s");

		if (rule.kind === "aggregate") {
			text.textContent = "Win when every " + rule.allOn + " is on a " + rule.goal;
		} else {
			const uses = rule.body.flatMap((statement) => ("use" in statement ? [statement.use] : []));

			text.textContent = "When " + (rule.on === "keyDirection" ? "a key is pressed" : "every tick") + " · for each " + rule.subject + (uses.length > 0 ? " → " + uses.join(", ") : "");
		}

		const remove = plainButton("×", `Remove ${rule.name}`, () => {
			model.rules = rules.filter((other) => other !== rule);
			rerender();
		});

		card.append(text, remove);
		container.append(card);
	}

	const addRule = element("div", "event-sheet-section");

	addRule.append(button("＋ Rule", () => {
		void (async (): Promise<void> => {
			const when = await host.pick(["When a key is pressed", "Every tick", "Win when…"], { "title": "Add a rule" });

			if (typeof when !== "string") {
				return;
			}

			if (when === "Win when…") {
				const these = await host.pick(entityNames, { "title": "Win when every…" });
				const goals = typeof these === "string" ? await host.pick(entityNames, { "title": "…is standing on a…" }) : undefined;
				const allOn = subjectOf(these ?? "");
				const goal = subjectOf(goals ?? "");

				if (allOn !== undefined && goal !== undefined) {
					addRuleTo({ "kind": "aggregate", "name": uniqueName(rules, "winSystem"), "on": "step", "allOn": allOn, "goal": goal });
				}

				return;
			}

			const subjectName = await host.pick(entityNames, { "title": "For each…" });
			const subject = subjectOf(subjectName ?? "");

			if (subject === undefined) {
				return;
			}

			const behavior = await host.pick(builtinBehaviors().map((entry) => entry.name), { "title": "Do what?" });

			if (typeof behavior === "string") {
				addRuleTo({ "kind": "perEntity", "name": uniqueName(rules, (subjectName ?? "each") + capitalize(behavior)), "subject": subject, "on": when === "When a key is pressed" ? "keyDirection" : "step", "body": [{ "use": behavior }] });
			}
		})();
	}));
	container.append(addRule);

	// ── behaviors (the reusable library rules compose) ─────────────────────────────────
	container.append(heading("BEHAVIORS", true));

	const behaviorList = element("div", "event-sheet-section wa-cluster wa-gap-2xs");

	behaviorList.append(...builtinBehaviors().map((behavior) => chip(behavior.name)));
	container.append(behaviorList, note("Reusable behaviors built from primitives — composed by rules. After Generate, open one to see there's no magic."));
}
