/**
 * Game-maker level surface (M1) — a PROJECTION of a `Tilemap` builder file (e.g. games/dozer's
 * `levels/level1.ts`) rendered as a tile grid.
 *
 * The code is the source of truth: this view parses the `new Tilemap(...)` + `addTileset`/`addLayer`/
 * `addObjectLayer`/`fill`/`bitblt` calls out of the ACTIVE text editor and composites them onto a canvas the
 * same way util/phaser/Tilemap.ts builds its data — so the grid you see is exactly what Phaser renders. It's one
 * more projection of the CST alongside the text (per the game-maker design); editing the code re-renders the
 * grid, and (M1b) painting the grid will write back into the `bitblt` array literal.
 *
 * Real DOM via `registerCustomView` — NOT a webview, so it composites under the coi-serviceworker single-origin
 * harness (same reason debug-preview-view.ts avoids webviews). Installed from workbench-entry.tsx.
 */
/* eslint-disable ts/no-explicit-any */
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";

type Api = any;

/** A tileset entry: its name and the image URL (data: or http). gid → tilesets[gid - 1] (firstgid = index+1). */
interface Tileset { "name": string; "url": string }
/** A tile layer: a flat width*height gid grid (0 = empty). Object layers instead carry placed `objects`. */
interface Layer { "name": string; "isObjectLayer": boolean; "data": number[]; "objects": { "gid": number; "tx": number; "ty": number }[] }
interface Level { "width": number; "height": number; "tileW": number; "tileH": number; "tilesets": Tileset[]; "layers": Layer[] }

/** Find each `.<method>(` call and return the substring of its parenthesised arguments (balanced parens). */
function callArgs(code: string, method: string): string[] {
	const out: string[] = [];
	const needle = "." + method + "(";
	let from = 0;

	for (;;) {
		const start = code.indexOf(needle, from);

		if (start === -1) {
			break;
		}

		let depth = 0;
		let i = start + needle.length - 1; // at the "("

		for (; i < code.length; i += 1) {
			const ch = code[i];

			if (ch === "(") { depth += 1; } else if (ch === ")") { depth -= 1; if (depth === 0) { break; } }
		}

		out.push(code.slice(start + needle.length, i));
		from = i + 1;
	}

	return out;
}

/** Read a JS 2D grid literal (with `_` for undefined) into a number[][] — `_`/undefined become 0. */
function parseGrid(arrayText: string): number[][] {
	const json = arrayText
		.replace(/\b_\b/gu, "null")
		.replace(/\bundefined\b/gu, "null")
		.replace(/,(\s*[\]}])/gu, "$1"); // trailing commas

	try {
		const raw = JSON.parse(json) as (number | null)[][];

		return raw.map((row) => row.map((cell) => cell ?? 0));
	} catch {
		return [];
	}
}

/** Parse a Tilemap builder file into a Level. Tolerant: unrecognised calls are ignored. */
export function parseLevel(code: string): Level | undefined {
	const ctor = /new\s+Tilemap\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d+)\s*,\s*(\d+))?\s*\)/u.exec(code);

	if (ctor === null) {
		return undefined;
	}

	const width = Number(ctor[1]);
	const height = Number(ctor[2]);
	const tileW = ctor[3] !== undefined ? Number(ctor[3]) : 32;
	const tileH = ctor[4] !== undefined ? Number(ctor[4]) : 32;

	const tilesets: Tileset[] = [];

	for (const args of callArgs(code, "addTileset")) {
		const match = /^\s*"([^"]+)"\s*,\s*"([^"]*)"/u.exec(args);

		if (match !== null) {
			tilesets.push({ "name": match[1], "url": match[2] });
		}
	}

	// Split the chain into per-layer chunks at each addLayer/addObjectLayer call, so a layer's fill/bitblt bind
	// to it (and not to a later layer). Each chunk runs until the next add(Object)Layer.
	const layers: Layer[] = [];
	const layerStarts = [...code.matchAll(/\.(addLayer|addObjectLayer)\(\s*"([^"]+)"\s*\)/gu)];

	for (let index = 0; index < layerStarts.length; index += 1) {
		const start = layerStarts[index];
		const isObjectLayer = start[1] === "addObjectLayer";
		const name = start[2];
		const chunkStart = start.index ?? 0;
		const chunkEnd = index + 1 < layerStarts.length ? (layerStarts[index + 1].index ?? code.length) : code.length;
		const chunk = code.slice(chunkStart, chunkEnd);

		const data = new Array<number>(width * height).fill(0);
		const objects: Layer["objects"] = [];

		const fill = /\.fill\(\s*(\d+)\s*\)/u.exec(chunk);

		if (fill !== null) {
			data.fill(Number(fill[1]));
		}

		for (const args of callArgs(chunk, "bitblt")) {
			const head = /^\s*(\d+)\s*,\s*(\d+)\s*,/u.exec(args);
			const bracket = args.indexOf("[");

			if (head === null || bracket === -1) {
				continue;
			}

			const dx = Number(head[1]);
			const dy = Number(head[2]);
			const grid = parseGrid(args.slice(bracket));

			// Replicate Tilemap.ts's exact index math (note the x/y transposition + inclusive loop bounds).
			for (let x = 0; x <= (grid[0]?.length ?? 0); x += 1) {
				for (let y = 0; y <= grid.length; y += 1) {
					const cell = grid[x]?.[y];

					if (cell === undefined || cell === 0) {
						continue;
					}

					if (isObjectLayer) {
						objects.push({ "gid": cell, "tx": dx + y, "ty": dy + x });
					} else {
						const ti = ((dy + x) * width) + dx + y;

						if (ti >= 0 && ti < data.length) {
							data[ti] = cell;
						}
					}
				}
			}
		}

		layers.push({ "name": name, "isObjectLayer": isObjectLayer, "data": data, "objects": objects });
	}

	return { "width": width, "height": height, "tileW": tileW, "tileH": tileH, "tilesets": tilesets, "layers": layers };
}

/** Load every tileset image; resolves once all are ready (missing/broken ones resolve to undefined). */
async function loadImages(tilesets: Tileset[]): Promise<(HTMLImageElement | undefined)[]> {
	return Promise.all(tilesets.map((tileset) => new Promise<HTMLImageElement | undefined>((resolve) => {
		const image = new Image();

		image.onload = (): void => { resolve(image); };
		image.onerror = (): void => { resolve(undefined); };
		image.src = tileset.url;
	})));
}

// ── M2: components (schemas) + object-spawn wiring ────────────────────────────────────────────────────────

/** An ECS component parsed from a schema file: a tag (no data) or a data component with named fields. */
interface Component { "name": string; "kind": "tag" | "data" | "enum"; "fields": string[] }
/** One object type's spawn config from game.ts's load() entityConfig: its components + render depth. */
interface EntityType { "name": string; "components": string[]; "depth"?: number }

/** Parse a bitECS-style component from one schema file. `new Uint…Array`/typed fields → data; `[]` → tag; a
 *  plain numeric object (e.g. Direction) → enum (not a component, shown separately). */
export function parseComponent(fileName: string, code: string): Component | undefined {
	const object = /export\s+const\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?\s*;/u.exec(code);

	if (object !== null) {
		const body = object[2];
		const fields = [...body.matchAll(/(?:"(\w+)"|(\w+))\s*:/gu)].map((match) => match[1] ?? match[2]);

		return { "name": object[1], "kind": /new\s+\w*Array|Float|Int|Uint/u.test(body) ? "data" : "enum", "fields": fields };
	}

	const tag = /export\s+const\s+(\w+)\s*(?::\s*number\[\])?\s*=\s*\[\s*\]/u.exec(code);

	if (tag !== null) {
		return { "name": tag[1], "kind": "tag", "fields": [] };
	}

	return undefined;
}

/** Parse game.ts's `load(scene, name, level, { <obj>: { components: [...], depth: N } })` entityConfig. `load`
 *  is imported and called BARE (not `obj.load(...)`), so match it at a word boundary and balance its parens. */
export function parseEntityConfig(code: string): EntityType[] {
	const call = /(?:^|[^.\w])load\s*\(/mu.exec(code);

	if (call === null) {
		return [];
	}

	let depthParen = 0;
	let end = call.index + call[0].length - 1; // at the "("

	for (; end < code.length; end += 1) {
		if (code[end] === "(") { depthParen += 1; } else if (code[end] === ")") { depthParen -= 1; if (depthParen === 0) { break; } }
	}

	const args = code.slice(call.index + call[0].length, end);
	const brace = args.indexOf("{");
	const configText = brace === -1 ? "" : args.slice(brace);

	if (configText === "") {
		return [];
	}

	const out: EntityType[] = [];
	// Each entry: `"name": { … }` — grab the name, then its brace-balanced body.
	const entry = /(?:"([^"]+)"|(\w+))\s*:\s*\{/gu;
	let match: RegExpExecArray | null;

	while ((match = entry.exec(configText)) !== null) {
		const name = match[1] ?? match[2];
		let depth = match.index + match[0].length - 1; // at the entry's "{"
		let level = 0;
		let i = depth;

		for (; i < configText.length; i += 1) {
			if (configText[i] === "{") { level += 1; } else if (configText[i] === "}") { level -= 1; if (level === 0) { break; } }
		}

		const body = configText.slice(depth, i + 1);
		const componentsMatch = /components\s*:\s*\[([^\]]*)\]/u.exec(body);
		const components = componentsMatch !== null ? componentsMatch[1].split(",").map((token) => token.trim()).filter(Boolean) : [];
		const depthMatch = /depth\s*:\s*(\d+)/u.exec(body);

		out.push({ "name": name, "components": components, "depth": depthMatch !== null ? Number(depthMatch[1]) : undefined });
		entry.lastIndex = i + 1;
	}

	return out;
}

/** Derive the game project root from a level file uri: the folder above `levels/`, else the file's folder. */
function projectRootPath(levelPath: string): string {
	const marker = levelPath.lastIndexOf("/levels/");

	return marker !== -1 ? levelPath.slice(0, marker) : levelPath.slice(0, levelPath.lastIndexOf("/"));
}

/** Read + parse the project's components (schemas/*.ts) and object-spawn wiring (game.ts). Tolerant of missing
 *  files. Uses the vscode workspace fs so it works on the shared zen-fs. */
async function readEntities(api: Api, levelUri: any): Promise<{ "components": Component[]; "objects": EntityType[] }> {
	const decoder = new TextDecoder();
	const rootPath = projectRootPath(String(levelUri.path));
	const root = levelUri.with({ "path": rootPath });
	const components: Component[] = [];
	let objects: EntityType[] = [];

	try {
		const schemasDir = api.Uri.joinPath(root, "schemas");
		const files = await api.workspace.fs.readDirectory(schemasDir) as [string, number][];

		for (const [name] of files) {
			if (!name.endsWith(".ts")) {
				continue;
			}

			try {
				const bytes = await api.workspace.fs.readFile(api.Uri.joinPath(schemasDir, name)) as Uint8Array;
				const component = parseComponent(name, decoder.decode(bytes));

				if (component !== undefined) {
					components.push(component);
				}
			} catch { /* skip unreadable file */ }
		}
	} catch { /* no schemas dir */ }

	try {
		const bytes = await api.workspace.fs.readFile(api.Uri.joinPath(root, "game.ts")) as Uint8Array;

		objects = parseEntityConfig(decoder.decode(bytes));
	} catch { /* no game.ts */ }

	return { "components": components, "objects": objects };
}

/** Small DOM helpers (kept module-level so no closures are created inside render loops → no-loop-func). */
function el(tag: string, css: string, text?: string): HTMLElement {
	const node = document.createElement(tag);

	node.style.cssText = css;

	if (text !== undefined) {
		node.textContent = text;
	}

	return node;
}

const CHIP_CSS = "display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;font-size:11px;white-space:nowrap";
const COMPONENT_COLORS: Record<Component["kind"], string> = {
	"data": "background:#1e3a5f;color:#9cc7ff",
	"tag": "background:#1e4620;color:#9fdf9f",
	"enum": "background:#3a3320;color:#e0cf9f"
};

/** Render the M2 inspector: a component palette (tag/data/enum) + each object's component + depth wiring. */
function renderInspector(host: HTMLElement, components: Component[], objects: EntityType[], level: Level): void {
	host.replaceChildren();
	host.style.cssText = "align-self:stretch;flex:0 0 auto;display:flex;flex-direction:column;gap:14px";

	const sectionCss = "display:flex;flex-direction:column;gap:6px";
	const headerCss = "font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#888";
	const wrapCss = "display:flex;flex-wrap:wrap;gap:6px";

	if (components.length > 0) {
		const section = el("div", sectionCss);

		section.appendChild(el("div", headerCss, `Components (${components.length})`));

		const wrap = el("div", wrapCss);

		for (const component of components) {
			const chip = el("span", `${CHIP_CSS};${COMPONENT_COLORS[component.kind]}`);

			chip.appendChild(el("span", "font-weight:600", component.name));
			chip.appendChild(el("span", "opacity:.7;font-size:10px", component.kind === "data" ? component.fields.join(",") : component.kind));
			wrap.appendChild(chip);
		}

		section.appendChild(wrap);
		host.appendChild(section);
	}

	if (objects.length > 0) {
		const section = el("div", sectionCss);

		section.appendChild(el("div", headerCss, `Objects (${objects.length})`));

		for (const object of objects) {
			const row = el("div", "display:flex;align-items:center;gap:8px;padding:6px;border:1px solid #333;border-radius:6px");
			const tileset = level.tilesets.find((entry) => entry.name === object.name);

			if (tileset !== undefined) {
				const swatch = document.createElement("img");

				swatch.src = tileset.url;
				swatch.style.cssText = "width:24px;height:24px;image-rendering:pixelated;flex:0 0 auto;background:#000";
				row.appendChild(swatch);
			}

			const label = el("div", "display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto");
			const title = el("div", "display:flex;align-items:center;gap:6px");

			title.appendChild(el("span", "font-weight:600", object.name));

			if (object.depth !== undefined) {
				title.appendChild(el("span", `${CHIP_CSS};background:#333;color:#aaa;font-size:10px;padding:1px 6px`, `depth ${object.depth}`));
			}

			label.appendChild(title);

			const chips = el("div", wrapCss);

			for (const componentName of object.components) {
				const known = components.find((entry) => entry.name === componentName);
				const style = known !== undefined ? COMPONENT_COLORS[known.kind] : "background:#333;color:#aaa";

				chips.appendChild(el("span", `${CHIP_CSS};${style}`, componentName));
			}

			label.appendChild(chips);
			row.appendChild(label);
			section.appendChild(row);
		}

		host.appendChild(section);
	}
}

export function installGameView(getApi: () => Api): void {
	registerCustomView({
		"id": "gameMaker.level",
		"name": "Level",
		"order": 1,
		"location": ViewContainerLocation.AuxiliaryBar,
		"renderBody": (container: HTMLElement) => {
			container.style.cssText = "height:100%;display:flex;flex-direction:column;background:#1e1e1e;color:#ccc;font:12px system-ui,sans-serif";

			const status = document.createElement("div");

			status.style.cssText = "padding:6px 10px;border-bottom:1px solid #333;flex:0 0 auto";
			status.textContent = "Open a Tilemap level file (e.g. levels/level1.ts) to see it here.";

			const stage = document.createElement("div");

			stage.style.cssText = "flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px";

			const canvas = document.createElement("canvas");

			canvas.style.cssText = "image-rendering:pixelated;background:#000;max-width:100%;box-shadow:0 0 0 1px #333;flex:0 0 auto";

			const inspector = document.createElement("div");

			inspector.style.cssText = "align-self:stretch;flex:0 0 auto";

			stage.append(canvas, inspector);
			container.append(status, stage);

			let token = 0;

			async function render(): Promise<void> {
				const api = getApi();
				const editor = api?.window?.activeTextEditor;
				const code: string | undefined = editor?.document?.getText();

				if (code === undefined || !code.includes("new Tilemap(")) {
					status.textContent = "Open a Tilemap level file (e.g. levels/level1.ts) to see it here.";
					canvas.style.display = "none";
					inspector.replaceChildren();

					return;
				}

				const level = parseLevel(code);

				if (level === undefined) {
					status.textContent = "Could not parse a Tilemap level from this file.";
					canvas.style.display = "none";
					inspector.replaceChildren();

					return;
				}

				token += 1;
				const mine = token;
				const images = await loadImages(level.tilesets);

				if (mine !== token) {
					return; // a newer render superseded us
				}

				canvas.width = level.width * level.tileW;
				canvas.height = level.height * level.tileH;
				canvas.style.display = "block";

				const context = canvas.getContext("2d");

				if (context === null) {
					return;
				}

				context.imageSmoothingEnabled = false;
				context.clearRect(0, 0, canvas.width, canvas.height);

				const drawTile = (gid: number, tx: number, ty: number): void => {
					const image = images[gid - 1];

					if (image !== undefined) {
						context.drawImage(image, tx * level.tileW, ty * level.tileH, level.tileW, level.tileH);
					}
				};

				for (const layer of level.layers) {
					if (layer.isObjectLayer) {
						for (const object of layer.objects) {
							drawTile(object.gid, object.tx, object.ty);
						}
					} else {
						for (let ti = 0; ti < layer.data.length; ti += 1) {
							if (layer.data[ti] !== 0) {
								drawTile(layer.data[ti], ti % level.width, Math.floor(ti / level.width));
							}
						}
					}
				}

				const fileName = String(editor.document.uri.path).split("/").pop();

				status.textContent = `${fileName} — ${level.width}×${level.height}, ${level.tilesets.length} tilesets, ${level.layers.length} layers`;

				// M2: entity inspector — components palette + per-object component/depth wiring, read from the
				// sibling schemas/*.ts and game.ts. The projection spans the whole game project, not just this file.
				inspector.replaceChildren();

				try {
					const { components, objects } = await readEntities(api, editor.document.uri);

					if (mine === token) {
						renderInspector(inspector, components, objects, level);
					}
				} catch { /* the inspector is optional — a bad read just leaves it empty */ }
			}

			void render();

			const api = getApi();
			const subs = [
				api?.window?.onDidChangeActiveTextEditor?.(() => { void render(); }),
				api?.workspace?.onDidChangeTextDocument?.((event: any) => {
					if (event?.document === api?.window?.activeTextEditor?.document) {
						void render();
					}
				})
			].filter(Boolean);

			return {
				"dispose": (): void => {
					for (const sub of subs) {
						sub?.dispose?.();
					}
				}
			};
		}
	});
}
