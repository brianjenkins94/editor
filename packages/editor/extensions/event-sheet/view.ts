/**
 * The Event Sheet's view — the script of its webview (extension.ts serves it): the game the active file belongs to, in
 * two faces of one model. MAP (read) is a cross-file structural map: OBJECTS (entity types + their traits), RULES (systems,
 * their subjects, event→action rows and the behaviors they compose), BEHAVIORS (the built-in library and the kid's own)
 * and COMPONENTS (the ECS data/tag traits underneath); every node opens the code it came from. BUILD (author) is
 * authoring.ts.
 *
 * The model is the reverse-projection of real code (code is the source of truth). The view asks its host — the
 * extension, over the webview's message channel — for everything outside the page: the game around the active file
 * (the nearest directory with a package.json, and its code), its projection (the recognizer, in the extension's
 * worker), opening a file at a line, writing generated files, and the prompts. The host says when to refresh: the active
 * editor changed, or a file was saved.
 */
import type { AuthoredGame } from "./generator";
import type { Behavior, Composite, GameModel, GameObject, Rule } from "./recognizer";
import css from "theme/exceptions/event-sheet.css?raw";
import { toolbar } from "theme/recipes";
import { styleSheet } from "theme/sheet";
import { followVsCodeTheme } from "theme/vscode";
import { button, chip, element, heading, renderAuthoring } from "./authoring";
import { authoredFromModel, blankGame, generateGame } from "./generator";

/** What the view asks of the extension: everything outside the webview. */
export interface EventSheetHost {
	/** The game around the active editor's file: its root (the nearest directory with a package.json) and its code
	 *  files (by path relative to the root); none when there's no code file open, or no package.json above it. */
	"game": () => Promise<{ "root": string; "files": Record<string, string> } | { "problem": string }>;
	/** The recognizer's model of a game's files (by path relative to its root). */
	"project": (root: string, files: Record<string, string>) => Promise<GameModel>;
	/** Open a file at a 1-based line. */
	"open": (path: string, line: number) => void;
	/** Write files under `root` (making their directories). */
	"writeFiles": (root: string, files: Record<string, string>) => Promise<void>;
	"info": (message: string) => void;
	"input": (options: { "title": string; "prompt": string }) => Promise<string | undefined>;
	"pick": (items: string[], options: { "title": string }) => Promise<string | undefined>;
}

/** The webview's channel to its extension (`acquireVsCodeApi`). */
interface VsCodeWebviewApi { "postMessage": (message: unknown) => void }

/** A call to the extension (`{ call, id, method, args }`), its answer (`{ answer, id, result | error }`), and the
 *  extension's word to refresh (`{ refresh: "editor" | "save" }`). */
export interface ViewMessage { "call": true; "id": number; "method": keyof EventSheetHost; "args": unknown[] }
export type HostMessage = { "answer": true; "id": number; "result"?: unknown; "error"?: string } | { "refresh": "editor" | "save" };

// Two faces of one model: Build (author) and Map (read). The authored block model is kept per game root, so edits
// persist (and don't re-project on every keystroke).
type ViewMode = "build" | "map";
let viewMode: ViewMode = "build";
const authoredByRoot = new Map<string, AuthoredGame>();

/** A row that opens code (`nested`: under a rule); `build` fills its content. */
function clickableRow(onClick: () => void, build: (row: HTMLElement) => void, nested = false): HTMLElement {
	const row = element("div", `event-sheet-row${nested ? " event-sheet-nested" : ""} wa-stack wa-gap-3xs`);

	row.addEventListener("click", onClick);
	build(row);

	return row;
}

/** A row's name, bold. */
function nameOf(text: string): HTMLElement {
	return element("span", "wa-font-weight-semibold", { "textContent": text });
}

/** Small, quiet text: what a row is, beside or under its name (`code`: in the code's type). */
function aside(text: string, code = false): HTMLElement {
	return element("span", `wa-caption-xs wa-color-text-quiet${code ? " app-code" : ""}`, { "textContent": text });
}

/** Tags, in a row. */
function chips(texts: string[]): HTMLElement {
	const row = element("div", "wa-cluster wa-gap-2xs");

	row.append(...texts.map((text) => chip(text)));

	return row;
}

function renderObjects(container: HTMLElement, host: EventSheetHost, root: string, objects: GameObject[]): void {
	container.append(heading("Objects · " + objects.length));

	for (const object of objects) {
		container.append(clickableRow(() => {
			host.open(root + "/" + object.defPath, object.defLine);
		}, (row) => {
			const header = element("div", "wa-split");

			header.append(nameOf(object.name), ...object.depth === undefined ? [] : [aside("depth " + object.depth)]);
			row.append(header, chips(object.behaviors));
		}));
	}
}

function renderRules(container: HTMLElement, host: EventSheetHost, root: string, rules: Rule[], composites: Map<string, Composite>): void {
	container.append(heading("Rules · " + rules.length));

	for (const rule of rules) {
		// The rule header — jumps to the system's definition; shows its subject(s) ("for each ...") and the behaviors it composes.
		container.append(clickableRow(() => {
			host.open(root + "/" + rule.defPath, rule.defLine);
		}, (row) => {
			row.append(nameOf(rule.name));

			if (rule.queries.length > 0) {
				row.append(aside("for each " + rule.queries.map((set) => set.join(" + ")).join(", ")));
			}

			// The behaviors this rule composes — clickable tags that jump to the behavior's definition.
			if (rule.composes.length > 0) {
				const uses = element("div", "wa-cluster wa-gap-2xs");

				for (const composedName of rule.composes) {
					const tag = chip("→ " + composedName);
					const composite = composites.get(composedName);

					if (composite !== undefined) {
						tag.addEventListener("click", (event) => {
							event.stopPropagation();
							host.open(root + "/" + composite.defPath, composite.defLine);
						});
					}

					uses.append(tag);
				}

				row.append(uses);
			}
		}));

		// Its event→action rows (indented) — each jumps to its own line.
		for (const eventRow of rule.rows) {
			container.append(clickableRow(() => {
				host.open(root + "/" + rule.defPath, eventRow.line);
			}, (row) => {
				const when = element("div", "wa-font-size-s");

				when.append(element("span", "wa-color-text-quiet", { "textContent": "when " }), element("span", "app-code", { "textContent": eventRow.event }));
				row.append(when, element("div", "app-code wa-font-size-s", { "textContent": "→ " + eventRow.actions.join("; ") }));
			}, true));
		}

		if (rule.rows.length === 0 && rule.composes.length === 0) {
			container.append(element("div", "event-sheet-section event-sheet-nested event-sheet-note wa-caption-xs wa-color-text-quiet", { "textContent": "opaque — custom code / runtime glue" }));
		}
	}
}

/** BEHAVIORS — the composed reusable behaviors (the built-in library + the kid's own): each a function of primitives. */
function renderComposites(container: HTMLElement, host: EventSheetHost, root: string, composites: Composite[]): void {
	if (composites.length === 0) {
		return;
	}

	container.append(heading("Behaviors · " + composites.length));

	for (const composite of composites) {
		container.append(clickableRow(() => {
			host.open(root + "/" + composite.defPath, composite.defLine);
		}, (row) => {
			row.append(nameOf(composite.name), chips([...composite.uses, ...composite.composes.map((sub) => "→ " + sub)]));
		}));
	}
}

/** COMPONENTS — the ECS components (data/tag traits) that objects and behaviors are built on. */
function renderComponents(container: HTMLElement, host: EventSheetHost, root: string, behaviors: Behavior[]): void {
	container.append(heading("Components · " + behaviors.length));

	for (const behavior of behaviors) {
		container.append(clickableRow(() => {
			host.open(root + "/" + behavior.defPath, behavior.defLine);
		}, (row) => {
			const header = element("div", "wa-split");

			header.append(element("span", "", { "textContent": behavior.name }), aside(behavior.kind === "data" ? "data (" + behavior.fields.join(", ") + ")" : "tag", true));
			row.append(header);
		}));
	}
}

/** A message in place of the view's content. */
function message(text: string): HTMLElement {
	return element("div", "event-sheet-message wa-color-text-quiet", { "textContent": text });
}

/** Render the whole model into the container. */
function paint(container: HTMLElement, host: EventSheetHost, root: string, model: GameModel): void {
	container.replaceChildren();

	if (model.objects.length === 0 && model.rules.length === 0 && model.behaviors.length === 0 && model.composites.length === 0) {
		container.append(message("No game recognized in " + (root.split("/").pop() ?? root) + "."));

		return;
	}

	const composites = new Map(model.composites.map((composite) => [composite.name, composite]));

	renderObjects(container, host, root, model.objects);
	renderRules(container, host, root, model.rules, composites);
	renderComposites(container, host, root, model.composites);
	renderComponents(container, host, root, model.behaviors);
}

/** The host, over the webview's message channel: each method a call the extension answers. */
function connect(vscode: VsCodeWebviewApi, onRefresh: (why: "editor" | "save") => void): EventSheetHost {
	let next = 0;
	const pending = new Map<number, { "resolve": (value: unknown) => void; "reject": (error: Error) => void }>();

	window.addEventListener("message", (event: MessageEvent) => {
		const message = event.data as HostMessage;

		if ("refresh" in message) {
			onRefresh(message.refresh);
		} else if (message.answer === true) {
			const call = pending.get(message.id);

			pending.delete(message.id);

			if (message.error === undefined) {
				call?.resolve(message.result);
			} else {
				call?.reject(new Error(message.error));
			}
		}
	});

	// (`never`: each method's own signature says what its answer is.)
	const call = (method: keyof EventSheetHost) => async (...args: unknown[]): Promise<never> => new Promise<never>((resolve, reject) => {
		next += 1;
		pending.set(next, { "resolve": resolve as (value: unknown) => void, "reject": reject });
		vscode.postMessage({ "call": true, "id": next, "method": method, "args": args } satisfies ViewMessage);
	});

	return {
		"game": call("game"),
		"project": call("project"),
		"open": (path, line) => { void call("open")(path, line); },
		"writeFiles": call("writeFiles"),
		"info": (message) => { void call("info")(message); },
		"input": call("input"),
		"pick": call("pick")
	};
}

function start(): void {
	const view = element("div", "app-frame wa-stack wa-gap-0");
	const bar = element("div", toolbar() + " wa-cluster wa-gap-2xs");
	const body = element("div", "event-sheet-body");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rebuilding = 0;

	// Web Awesome on the VS Code theme (theme/vscode, as in the workbench), then what it doesn't cover.
	document.head.append(styleSheet(css));
	followVsCodeTheme(document.body);
	// Fixed toggle bar on top; the body swaps between Build (author) and Map (read).
	view.append(bar, body);
	document.body.replaceChildren(view);

	const showMessage = (text: string): void => {
		body.replaceChildren(message(text));
	};

	const host = connect(acquireVsCodeApi(), (why) => {
		// A save re-projects the Map (debounced); Build is driven by its in-memory model, not the files.
		if (why === "save" && viewMode !== "map") {
			return;
		}

		clearTimeout(timer);
		timer = setTimeout(() => {
			void rebuild();
		}, why === "save" ? 300 : 0);
	});

	// Scaffold a blank, runnable game the user owns, then open it (the view follows the editor there, in Build, with a
	// paintable empty grid).
	const createGame = async (name: string): Promise<void> => {
		const dest = "/workspace/games/" + name.replace(/[^\w.-]+/gu, "-");
		const game = blankGame();

		await host.writeFiles(dest, generateGame(game));
		authoredByRoot.set(dest, game);
		viewMode = "build";
		host.open(dest + "/game.ts", 1);
	};

	const renderToggle = (): void => {
		bar.replaceChildren(...(["build", "map"] as const).map((mode) => button(mode === "build" ? "Build" : "Map", () => {
			viewMode = mode;
			void rebuild();
		}, viewMode === mode)));
	};

	async function rebuild(): Promise<void> {
		// Only the latest rebuild paints: an earlier one still loading gives way.
		rebuilding += 1;

		const mine = rebuilding;

		renderToggle();

		const game = await host.game();

		if (mine !== rebuilding) {
			return;
		}

		if ("problem" in game) {
			showMessage(game.problem);

			return;
		}

		if (viewMode === "build") {
			// Author face: seed the block model from the recognized game once, then edit locally (no re-projection).
			let authored = authoredByRoot.get(game.root);

			if (authored === undefined) {
				showMessage("Loading…");

				try {
					authored = authoredFromModel(await host.project(game.root, game.files));
				} catch {
					authored = { "level": "level1", "entities": [], "systems": [] };
				}

				if (mine !== rebuilding) {
					return;
				}

				authoredByRoot.set(game.root, authored);
			}

			renderAuthoring(body, host, game.root, authored, {
				"rerender": () => {
					void rebuild();
				},
				"createGame": createGame
			});

			return;
		}

		// Map face: reverse-project the current code.
		showMessage("Projecting…");

		try {
			const model = await host.project(game.root, game.files);

			if (mine === rebuilding) {
				paint(body, host, game.root, model);
			}
		} catch (error) {
			if (mine === rebuilding) {
				showMessage("Projection failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}
	}

	void rebuild();
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;

start();
