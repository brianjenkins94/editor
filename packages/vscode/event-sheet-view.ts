/**
 * The Event Sheet augmentation — the FIRST file augmentation (see file-augmentations.ts). A projection of the game the
 * active file belongs to, rendered in the auxpane as a cross-file structural map: OBJECTS (entity types + their
 * behaviors), RULES (systems + their subjects and event→action rows), and the BEHAVIORS library. Every node deep-links
 * to where its code actually lives — click and the editor opens that file at that line.
 *
 * The model is the REVERSE-PROJECTION of real code (code is the source of truth): the game's files are read and sent to
 * the recognizer worker (game-projection.ts → recognizer-worker.ts, which runs on the editor's shared TypeScript), and
 * the plain-JSON GameModel comes back. The "game" is scoped to the nearest ancestor directory with a package.json.
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings -- a plain structural map in the aux-bar body; intrinsic layout, not themeable chrome */
import type { AugmentationContext, FileAugmentation } from "./file-augmentations";
import type { AuthoredGame } from "./game-generator";
import type { Behavior, GameModel, GameObject, Rule } from "./game-recognizer";
import { renderAuthoring, writeGeneratedGame } from "./authoring-view";
import { authoredFromModel, blankGame, generateGame } from "./game-generator";
import { createGameProjection, type GameProjection } from "./game-projection";

const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const IGNORE = /(?:^|\/)(?:node_modules|\.git|\.silo|dist|assets)(?:\/|$)/u;
const BORDER = "1px solid var(--vscode-panel-border,#2a2a2a)";

// One recognizer worker for the session (spawned lazily; keeps ts out of the main bundle). See game-projection.ts.
let projection: GameProjection | undefined;
const getProjection = (): GameProjection => (projection ??= createGameProjection());

// The auxpane has two faces of one model: Build (author) and Map (read). Mode is sticky across activations; the authored
// block model is cached per game root so edits persist (and don't re-project on every keystroke).
type ViewMode = "build" | "map";
let viewMode: ViewMode = "build";
const authoredByRoot = new Map<string, AuthoredGame>();

/** The nearest ancestor directory of `uri` that has a package.json — the game root (a game is a package). */
async function findGameRoot(api: any, uri: any): Promise<string | undefined> {
	let dir = String(uri.path ?? "").replace(/\/[^/]*$/u, "");

	while (dir !== "" && dir !== "/") {
		try {
			await api.workspace.fs.stat(api.Uri.file(dir + "/package.json"));

			return dir;
		} catch { /* keep walking up */ }

		dir = dir.replace(/\/[^/]*$/u, "");
	}

	return undefined;
}

/** Read every code file under `root` (skipping deps/build/assets and .d.ts), keyed by path RELATIVE to root. */
async function readGameFiles(api: any, root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const decoder = new TextDecoder();

	const walk = async (dir: string): Promise<void> => {
		let entries: [string, number][];

		try {
			entries = await api.workspace.fs.readDirectory(api.Uri.file(dir));
		} catch {
			return;
		}

		for (const [name, type] of entries) {
			const full = dir + "/" + name;

			if (IGNORE.test(full)) {
				continue;
			}

			if (type === api.FileType.Directory) {
				await walk(full);
			} else if (CODE_FILE.test(name) && !name.endsWith(".d.ts")) {
				try {
					files[full.slice(root.length + 1)] = decoder.decode(await api.workspace.fs.readFile(api.Uri.file(full)));
				} catch { /* unreadable — skip */ }
			}
		}
	};

	await walk(root);

	return files;
}

/** Reveal a file (relative to the game root) at a 1-based line. */
async function openAt(api: any, root: string, relPath: string, line: number): Promise<void> {
	const editor = await api.window.showTextDocument(api.Uri.file(root + "/" + relPath), { "preserveFocus": false });
	const position = new api.Position(Math.max(0, line - 1), 0);

	editor.selection = new api.Selection(position, position);
	editor.revealRange(new api.Range(position, position), api.TextEditorRevealType.InCenter);
}

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

function renderObjects(container: HTMLElement, api: any, root: string, objects: GameObject[]): void {
	container.append(heading("Objects · " + objects.length));

	for (const object of objects) {
		container.append(clickableRow(() => { void openAt(api, root, object.defPath, object.defLine); }, (row) => {
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

function renderRules(container: HTMLElement, api: any, root: string, rules: Rule[]): void {
	container.append(heading("Rules · " + rules.length));

	for (const rule of rules) {
		// The rule header — jumps to the system's definition; shows its subject(s) ("for each ...").
		container.append(clickableRow(() => { void openAt(api, root, rule.defPath, rule.defLine); }, (row) => {
			const name = document.createElement("span");

			name.textContent = rule.name;
			name.style.cssText = "font-weight:600";
			row.append(name);

			const subject = document.createElement("div");

			subject.textContent = rule.queries.length === 0 ? "" : "for each " + rule.queries.map((set) => set.join(" + ")).join(", ");
			subject.style.cssText = "font-size:11px;opacity:0.6;margin-top:2px";
			row.append(subject);
		}));

		// Its event→action rows (indented) — each jumps to its own line.
		for (const eventRow of rule.rows) {
			container.append(clickableRow(() => { void openAt(api, root, rule.defPath, eventRow.line); }, (element) => {
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

		if (rule.rows.length === 0) {
			const note = document.createElement("div");

			note.textContent = "opaque — custom code / runtime glue";
			note.style.cssText = "padding:2px 10px 6px 22px;font-size:11px;font-style:italic;opacity:0.45";
			container.append(note);
		}
	}
}

function renderBehaviors(container: HTMLElement, api: any, root: string, behaviors: Behavior[]): void {
	container.append(heading("Behaviors · " + behaviors.length));

	for (const behavior of behaviors) {
		container.append(clickableRow(() => { void openAt(api, root, behavior.defPath, behavior.defLine); }, (row) => {
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
function paint(container: HTMLElement, context: AugmentationContext, root: string, model: GameModel): void {
	container.replaceChildren();

	if (model.objects.length === 0 && model.rules.length === 0 && model.behaviors.length === 0) {
		const note = document.createElement("div");

		note.textContent = "No game recognized in " + (root.split("/").pop() ?? root) + ".";
		note.style.cssText = "padding:12px;font-size:13px;opacity:0.6";
		container.append(note);

		return;
	}

	renderObjects(container, context.api, root, model.objects);
	renderRules(container, context.api, root, model.rules);
	renderBehaviors(container, context.api, root, model.behaviors);
}

/** The event-sheet augmentation: projects the active file's game into the auxpane, deep-linking every node. */
export const eventSheetAugmentation: FileAugmentation = {
	"id": "event-sheet",
	"title": "Event Sheet",
	"when": (document: any) => CODE_FILE.test(String(document.uri?.path ?? "")),
	"render": (container, context) => {
		const { api } = context;
		let disposed = false;

		// Fixed toggle bar on top; the body swaps between Build (author) and Map (read).
		container.style.cssText = "height:100%;display:flex;flex-direction:column;overflow:hidden";

		const bar = document.createElement("div");

		bar.style.cssText = "display:flex;gap:4px;padding:6px 10px;border-bottom:" + BORDER + ";flex:none";

		const body = document.createElement("div");

		body.style.cssText = "flex:1;overflow:auto;min-height:0";
		container.replaceChildren(bar, body);

		const showMessage = (text: string): void => {
			const note = document.createElement("div");

			note.textContent = text;
			note.style.cssText = "padding:12px;font-size:13px;opacity:0.6";
			body.replaceChildren(note);
		};

		// Declared out of the loop so the click handler doesn't close over the mutable `viewMode`.
		const setMode = (mode: ViewMode): void => { viewMode = mode; void rebuild(); };

		// Scaffold a blank, runnable game the user owns, then open it (its own augmentation instance renders in Build,
		// reading the seeded block model — a paintable empty grid).
		const createGame = async (name: string): Promise<void> => {
			const dest = "/workspace/games/" + name.replace(/[^\w.-]+/gu, "-");
			const game = blankGame();

			await writeGeneratedGame(api, dest, generateGame(game));
			authoredByRoot.set(dest, game);
			viewMode = "build";
			await api.window.showTextDocument(api.Uri.file(dest + "/game.ts"));
		};

		const renderToggle = (): void => {
			bar.replaceChildren();

			for (const mode of ["build", "map"] as const) {
				const toggle = document.createElement("wa-button");

				toggle.setAttribute("size", "small");
				toggle.setAttribute("appearance", "outlined");

				if (viewMode === mode) {
					toggle.setAttribute("variant", "brand");
				}

				toggle.textContent = mode === "build" ? "Build" : "Map";
				toggle.addEventListener("click", () => { setMode(mode); });
				bar.append(toggle);
			}
		};

		const rebuild = async (): Promise<void> => {
			renderToggle();

			const root = await findGameRoot(api, context.document.uri);

			if (disposed) {
				return;
			}

			if (root === undefined) {
				showMessage("No package.json above this file — can't locate a game.");

				return;
			}

			if (viewMode === "build") {
				// Author face: seed the block model from the recognized game once, then edit locally (no re-projection).
				let authored = authoredByRoot.get(root);

				if (authored === undefined) {
					showMessage("Loading…");

					try {
						authored = authoredFromModel(await getProjection().project(await readGameFiles(api, root)));
					} catch {
						authored = { "level": "level1", "entities": [], "systems": [] };
					}

					if (disposed) {
						return;
					}

					authoredByRoot.set(root, authored);
				}

				renderAuthoring(body, api, root, authored, { "rerender": () => { void rebuild(); }, "createGame": createGame });

				return;
			}

			// Map face: reverse-project the current code.
			showMessage("Projecting…");

			try {
				const model = await getProjection().project(await readGameFiles(api, root));

				if (!disposed) {
					paint(body, context, root, model);
				}
			} catch (error) {
				if (!disposed) {
					showMessage("Projection failed: " + (error instanceof Error ? error.message : String(error)));
				}
			}
		};

		// Re-project the Map on save (debounced), so it tracks the code.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const sub = api.workspace.onDidSaveTextDocument(() => {
			if (viewMode !== "map") {
				return; // Build is driven by the in-memory model, not the files
			}

			if (timer !== undefined) {
				clearTimeout(timer);
			}

			timer = setTimeout(() => { void rebuild(); }, 300);
		});

		void rebuild();

		return {
			"dispose": (): void => {
				disposed = true;

				if (timer !== undefined) {
					clearTimeout(timer);
				}

				sub.dispose();
				container.replaceChildren();
			}
		};
	}
};
