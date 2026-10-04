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
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings -- a plain structural map in a webview; intrinsic layout, not themeable chrome */
import type { AuthoredGame } from "./generator";
import type { Behavior, Composite, GameModel, GameObject, Rule } from "./recognizer";
import { button, renderAuthoring } from "./authoring";
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
export type ViewMessage = { "call": true; "id": number; "method": keyof EventSheetHost; "args": unknown[] };
export type HostMessage = { "answer": true; "id": number; "result"?: unknown; "error"?: string } | { "refresh": "editor" | "save" };

const BORDER = "1px solid var(--vscode-panel-border,#2a2a2a)";

// Two faces of one model: Build (author) and Map (read). The authored block model is kept per game root, so edits
// persist (and don't re-project on every keystroke).
type ViewMode = "build" | "map";
let viewMode: ViewMode = "build";
const authoredByRoot = new Map<string, AuthoredGame>();

/** A muted section heading. */
function heading(text: string): HTMLElement {
	const element = document.createElement("div");

	element.textContent = text;
	element.style.cssText = "padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;opacity:0.6";

	return element;
}

/** A clickable row that deep-links; `build` fills its content. */
function clickableRow(onClick: () => void, build: (row: HTMLElement) => void): HTMLElement {
	const row = document.createElement("div");

	row.style.cssText = "padding:5px 10px;cursor:pointer;border-bottom:" + BORDER;
	row.addEventListener("mouseenter", () => { row.style.background = "var(--vscode-list-hoverBackground,#2a2d2e)"; });
	row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
	row.addEventListener("click", onClick);
	build(row);

	return row;
}

/** A small behavior chip. */
function chip(text: string): HTMLElement {
	const element = document.createElement("span");

	element.textContent = text;
	element.style.cssText = "display:inline-block;margin:1px 3px 1px 0;padding:0 6px;border-radius:8px;font-size:11px;background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff)";

	return element;
}

function renderObjects(container: HTMLElement, host: EventSheetHost, root: string, objects: GameObject[]): void {
	container.append(heading("Objects · " + objects.length));

	for (const object of objects) {
		container.append(clickableRow(() => { host.open(root + "/" + object.defPath, object.defLine); }, (row) => {
			const name = document.createElement("span");

			name.textContent = object.name;
			name.style.cssText = "font-weight:600";
			row.append(name);

			if (object.depth !== undefined) {
				const depth = document.createElement("span");

				depth.textContent = "depth " + object.depth;
				depth.style.cssText = "float:right;font-size:11px;opacity:0.5";
				row.append(depth);
			}

			const chips = document.createElement("div");

			chips.style.cssText = "margin-top:3px";

			for (const behavior of object.behaviors) {
				chips.append(chip(behavior));
			}

			row.append(chips);
		}));
	}
}

function renderRules(container: HTMLElement, host: EventSheetHost, root: string, rules: Rule[], composites: Map<string, Composite>): void {
	container.append(heading("Rules · " + rules.length));

	for (const rule of rules) {
		// The rule header — jumps to the system's definition; shows its subject(s) ("for each ...") and the behaviors it composes.
		container.append(clickableRow(() => { host.open(root + "/" + rule.defPath, rule.defLine); }, (row) => {
			const name = document.createElement("span");

			name.textContent = rule.name;
			name.style.cssText = "font-weight:600";
			row.append(name);

			const subject = document.createElement("div");

			subject.textContent = rule.queries.length === 0 ? "" : "for each " + rule.queries.map((set) => set.join(" + ")).join(", ");
			subject.style.cssText = "font-size:11px;opacity:0.6;margin-top:2px";
			row.append(subject);

			// The behaviors this rule composes — clickable chips that jump to the behavior's definition.
			if (rule.composes.length > 0) {
				const uses = document.createElement("div");

				uses.style.cssText = "margin-top:3px";

				for (const composedName of rule.composes) {
					const element = chip("→ " + composedName);
					const composite = composites.get(composedName);

					if (composite !== undefined) {
						element.style.cursor = "pointer";
						element.addEventListener("click", (event) => { event.stopPropagation(); host.open(root + "/" + composite.defPath, composite.defLine); });
					}

					uses.append(element);
				}

				row.append(uses);
			}
		}));

		// Its event→action rows (indented) — each jumps to its own line.
		for (const eventRow of rule.rows) {
			container.append(clickableRow(() => { host.open(root + "/" + rule.defPath, eventRow.line); }, (element) => {
				element.style.paddingLeft = "22px";

				const when = document.createElement("span");

				when.textContent = "when ";
				when.style.cssText = "opacity:0.5;font-size:12px";

				const cond = document.createElement("span");

				cond.textContent = eventRow.event;
				cond.style.cssText = "font-family:var(--monaco-monospace-font,monospace);font-size:12px";
				element.append(when, cond);

				const does = document.createElement("div");

				does.textContent = "→ " + eventRow.actions.join("; ");
				does.style.cssText = "font-family:var(--monaco-monospace-font,monospace);font-size:12px;opacity:0.8;margin-top:2px";
				element.append(does);
			}));
		}

		if (rule.rows.length === 0 && rule.composes.length === 0) {
			const note = document.createElement("div");

			note.textContent = "opaque — custom code / runtime glue";
			note.style.cssText = "padding:2px 10px 6px 22px;font-size:11px;font-style:italic;opacity:0.45";
			container.append(note);
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
		container.append(clickableRow(() => { host.open(root + "/" + composite.defPath, composite.defLine); }, (row) => {
			const name = document.createElement("span");

			name.textContent = composite.name;
			name.style.cssText = "font-weight:600";
			row.append(name);

			const chips = document.createElement("div");

			chips.style.cssText = "margin-top:3px";

			for (const use of composite.uses) {
				chips.append(chip(use));
			}

			for (const sub of composite.composes) {
				chips.append(chip("→ " + sub));
			}

			row.append(chips);
		}));
	}
}

/** COMPONENTS — the ECS components (data/tag traits) that objects and behaviors are built on. */
function renderComponents(container: HTMLElement, host: EventSheetHost, root: string, behaviors: Behavior[]): void {
	container.append(heading("Components · " + behaviors.length));

	for (const behavior of behaviors) {
		container.append(clickableRow(() => { host.open(root + "/" + behavior.defPath, behavior.defLine); }, (row) => {
			const name = document.createElement("span");

			name.textContent = behavior.name;
			row.append(name);

			const kind = document.createElement("span");

			kind.textContent = behavior.kind === "data" ? "data (" + behavior.fields.join(", ") + ")" : "tag";
			kind.style.cssText = "float:right;font-size:11px;opacity:0.5;font-family:var(--monaco-monospace-font,monospace)";
			row.append(kind);
		}));
	}
}

/** Render the whole model into the container. */
function paint(container: HTMLElement, host: EventSheetHost, root: string, model: GameModel): void {
	container.replaceChildren();

	if (model.objects.length === 0 && model.rules.length === 0 && model.behaviors.length === 0 && model.composites.length === 0) {
		const note = document.createElement("div");

		note.textContent = "No game recognized in " + (root.split("/").pop() ?? root) + ".";
		note.style.cssText = "padding:12px;font-size:13px;opacity:0.6";
		container.append(note);

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
	const container = document.body;
	const bar = document.createElement("div");
	const body = document.createElement("div");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rebuilding = 0;

	// Fixed toggle bar on top; the body swaps between Build (author) and Map (read).
	container.style.cssText = "margin:0;padding:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;font:13px var(--vscode-font-family);color:var(--vscode-foreground)";
	bar.style.cssText = "display:flex;gap:4px;padding:6px 10px;border-bottom:" + BORDER + ";flex:none";
	body.style.cssText = "flex:1;overflow:auto;min-height:0";
	container.replaceChildren(bar, body);

	const showMessage = (text: string): void => {
		const note = document.createElement("div");

		note.textContent = text;
		note.style.cssText = "padding:12px;font-size:13px;opacity:0.6";
		body.replaceChildren(note);
	};

	const host = connect(acquireVsCodeApi(), (why) => {
		// A save re-projects the Map (debounced); Build is driven by its in-memory model, not the files.
		if (why === "save" && viewMode !== "map") {
			return;
		}

		clearTimeout(timer);
		timer = setTimeout(() => { void rebuild(); }, why === "save" ? 300 : 0);
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
		bar.replaceChildren(...(["build", "map"] as const).map((mode) => button(mode === "build" ? "Build" : "Map", () => { viewMode = mode; void rebuild(); }, viewMode === mode)));
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

			renderAuthoring(body, host, game.root, authored, { "rerender": () => { void rebuild(); }, "createGame": createGame });

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
