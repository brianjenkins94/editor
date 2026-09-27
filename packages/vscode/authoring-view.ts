/**
 * Authoring prototype — the WRITE face of the Event Sheet, rendered in the same auxpane as the read Map. You assemble a
 * game from the palette (objects + behaviors + systems); "Generate" VENDORS the code into the game dir (the user owns it)
 * — the read map then re-projects it and, if a dev server is running, HMR shows it run. This is a prototype to feel the
 * drag-and-drop/Automator experience in-editor; the model + generator underneath are the real foundation.
 *
 * (Editing is click-to-add via native quick-picks for now — the Automator "add an action from a list" feel; true
 * drag-and-drop reordering is a later polish.)
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings -- a prototype authoring surface in the aux-bar body; intrinsic layout, not themeable chrome */
import type { AuthoredGame } from "./game-generator";
import { generateGame, libraryComponents, librarySystems } from "./game-generator";

const BORDER = "1px solid var(--vscode-panel-border,#2a2a2a)";
/** The starter template a "New game" is scaffolded from — a complete, runnable game (level w/ inline data-URL sprites,
 *  Tilemap loader, scene glue, index.html) the new game vendors and OWNS. */
const STARTER_TEMPLATE = "/workspace/samples/dozer";

/** Recursively copy a game dir (all text files; sprites are inline data URLs so there are no binaries to worry about). */
async function copyDir(api: any, from: string, to: string): Promise<void> {
	await api.workspace.fs.createDirectory(api.Uri.file(to));

	for (const [name, type] of await api.workspace.fs.readDirectory(api.Uri.file(from))) {
		const source = from + "/" + name;
		const destination = to + "/" + name;

		if (type === api.FileType.Directory) {
			await copyDir(api, source, destination);
		} else {
			await api.workspace.fs.writeFile(api.Uri.file(destination), await api.workspace.fs.readFile(api.Uri.file(source)));
		}
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

/** Render the authoring editor for `model` into `container`; edits mutate the model and call `rerender`. */
export function renderAuthoring(container: HTMLElement, api: any, root: string, model: AuthoredGame, rerender: () => void): void {
	container.replaceChildren();
	container.style.cssText = "height:100%;overflow:auto;padding-bottom:12px";

	// ── toolbar ──────────────────────────────────────────────────────────────────
	const toolbar = document.createElement("div");

	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:" + BORDER;

	const generate = button("Generate", () => {
		void (async (): Promise<void> => {
			const files = generateGame(model);
			const encoder = new TextEncoder();

			for (const [relative, content] of Object.entries(files)) {
				await api.workspace.fs.writeFile(api.Uri.file(root + "/" + relative), encoder.encode(content));
			}

			api.window.showInformationMessage?.("Vendored " + Object.keys(files).length + " files into " + (root.split("/").pop() ?? root));
		})();
	});

	generate.setAttribute("variant", "brand");

	const newGame = button("New game", () => {
		void (async (): Promise<void> => {
			const chosen = await api.window.showInputBox({ "title": "New game", "prompt": "Name — scaffolds a runnable game you own, then author it in Build" });

			if (typeof chosen !== "string" || chosen.trim() === "") {
				return;
			}

			const dest = "/workspace/games/" + chosen.trim().replace(/[^\w.-]+/gu, "-");

			try {
				await api.workspace.fs.stat(api.Uri.file(STARTER_TEMPLATE));
			} catch {
				api.window.showErrorMessage?.("Starter template not found at " + STARTER_TEMPLATE);

				return;
			}

			try {
				await copyDir(api, STARTER_TEMPLATE, dest);
				await api.window.showTextDocument(api.Uri.file(dest + "/game.ts"));
				api.window.showInformationMessage?.("Scaffolded " + dest + " — it's yours; edit it in Build.");
			} catch (error) {
				api.window.showErrorMessage?.("New game failed: " + (error instanceof Error ? error.message : String(error)));
			}
		})();
	});

	toolbar.append(generate, newGame);
	container.append(toolbar);

	// ── objects ──────────────────────────────────────────────────────────────────
	const objectsHeading = document.createElement("div");

	objectsHeading.textContent = "OBJECTS";
	objectsHeading.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;opacity:0.6";
	container.append(objectsHeading);

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

	const addObject = document.createElement("div");

	addObject.style.cssText = "padding:6px 10px";
	addObject.append(button("＋ Add object", () => {
		void (async (): Promise<void> => {
			const objectName = await api.window.showInputBox({ "title": "New object", "prompt": "Object name (e.g. crate)" });

			if (typeof objectName === "string" && objectName.trim() !== "") {
				model.entities.push({ "name": objectName.trim(), "components": [], "depth": 0 });
				rerender();
			}
		})();
	}));
	container.append(addObject);

	// ── systems ──────────────────────────────────────────────────────────────────
	const systemsHeading = document.createElement("div");

	systemsHeading.textContent = "SYSTEMS";
	systemsHeading.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;opacity:0.6;border-top:" + BORDER;
	container.append(systemsHeading);

	const systemChips = document.createElement("div");

	systemChips.style.cssText = "padding:2px 10px";

	for (const system of model.systems) {
		systemChips.append(chip(system, () => {
			model.systems = model.systems.filter((other) => other !== system);
			rerender();
		}));
	}

	const addSystem = document.createElement("span");

	addSystem.textContent = "＋ system";
	addSystem.style.cssText = "cursor:pointer;font-size:11px;opacity:0.6";
	addSystem.addEventListener("click", () => {
		void (async (): Promise<void> => {
			const options = librarySystems().filter((system) => !model.systems.includes(system));
			const picked = await api.window.showQuickPick(options, { "title": "Add system" });

			if (typeof picked === "string") {
				model.systems.push(picked);
				rerender();
			}
		})();
	});

	systemChips.append(addSystem);
	container.append(systemChips);
}
