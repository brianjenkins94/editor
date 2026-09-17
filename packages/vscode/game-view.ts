/**
 * Game-maker "Level" surface — a PROJECTION of a game project (a Tilemap builder file + its sibling schemas/*.ts
 * and game.ts), rendered as a tile grid plus a component/object/system inspector.
 *
 * This file is BABLR-FREE: it's a thin client. It gathers the project's source files (via the vscode workspace fs)
 * and hands them to the game-worker over hub RPC (`game.project`); the worker parses the BABLR CST off-thread and
 * returns the plain GameProjection model, which we render here. The code is the source of truth; each panel is a
 * projection of it (per the game-maker design). Real DOM via `registerCustomView` — NOT a webview, so it
 * composites under the coi-serviceworker single-origin harness (same reason debug-preview-view.ts avoids them).
 */
/* eslint-disable ts/no-explicit-any */
import type { Hub } from "@brianjenkins94/hub";
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";
import { createRpcClient, portTransport } from "@brianjenkins94/hub";

import type { Component, EntityType, GameProjection, Level, ProjectSources, System, Tileset } from "./game-model";

type Api = any;

// ── small DOM helpers (module-level: no closures created inside render loops → no-loop-func) ─────────────────
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

/** Load every tileset image; resolves once all are ready (missing/broken ones resolve to undefined). */
async function loadImages(tilesets: Tileset[]): Promise<(HTMLImageElement | undefined)[]> {
	return Promise.all(tilesets.map((tileset) => new Promise<HTMLImageElement | undefined>((resolve) => {
		const image = new Image();

		image.onload = (): void => { resolve(image); };
		image.onerror = (): void => { resolve(undefined); };
		image.src = tileset.url;
	})));
}

// ── gathering the project sources (client side) ─────────────────────────────────────────────────────────────
/** Walk up from a project file to the nearest ancestor dir containing game.ts (the project root). */
async function findProjectRoot(api: Api, uri: any): Promise<any> {
	let dir = uri.with({ "path": String(uri.path).slice(0, String(uri.path).lastIndexOf("/")) });

	for (let up = 0; up < 4; up += 1) {
		try {
			await api.workspace.fs.stat(api.Uri.joinPath(dir, "game.ts"));

			return dir;
		} catch { /* not here — go up */ }

		const parentPath = String(dir.path).slice(0, String(dir.path).lastIndexOf("/"));

		if (parentPath === "" || parentPath === String(dir.path)) {
			break;
		}

		dir = dir.with({ "path": parentPath });
	}

	return undefined;
}

/** Read every `.ts` file in `dir` as `{ file, code }` (tolerant of a missing dir). */
async function readTsDir(api: Api, dir: any): Promise<{ "file": string; "code": string }[]> {
	const out: { "file": string; "code": string }[] = [];
	const decoder = new TextDecoder();

	try {
		for (const [name] of await api.workspace.fs.readDirectory(dir) as [string, number][]) {
			if (!name.endsWith(".ts")) {
				continue;
			}

			try {
				const uri = api.Uri.joinPath(dir, name);
				const bytes = await api.workspace.fs.readFile(uri) as Uint8Array;

				out.push({ "file": String(uri.path), "code": decoder.decode(bytes) });
			} catch { /* skip unreadable */ }
		}
	} catch { /* no dir */ }

	return out;
}

/** Gather a level file + its project's game.ts / schemas / systems into a ProjectSources for the worker. */
async function gatherSources(api: Api, levelUri: any, levelCode: string): Promise<ProjectSources> {
	const sources: ProjectSources = { "levelFile": String(levelUri.path), "levelCode": levelCode, "schemas": [], "systems": [] };
	const root = await findProjectRoot(api, levelUri);

	if (root === undefined) {
		return sources;
	}

	const decoder = new TextDecoder();

	try {
		const gameUri = api.Uri.joinPath(root, "game.ts");

		sources.gameFile = String(gameUri.path);
		sources.gameCode = decoder.decode(await api.workspace.fs.readFile(gameUri) as Uint8Array);
	} catch { /* no game.ts */ }

	sources.schemas = await readTsDir(api, api.Uri.joinPath(root, "schemas"));
	sources.systems = await readTsDir(api, api.Uri.joinPath(root, "systems"));

	return sources;
}

// ── rendering the model ─────────────────────────────────────────────────────────────────────────────────────
/** Draw the composited level onto `canvas` (fill per layer, then each placed tile). */
function renderLevelCanvas(canvas: HTMLCanvasElement, level: Level, images: (HTMLImageElement | undefined)[]): void {
	canvas.width = level.width * level.tileW;
	canvas.height = level.height * level.tileH;

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
		if (layer.fill !== undefined && layer.fill !== 0) {
			for (let ty = 0; ty < level.height; ty += 1) {
				for (let tx = 0; tx < level.width; tx += 1) {
					drawTile(layer.fill, tx, ty);
				}
			}
		}

		for (const tile of layer.tiles) {
			drawTile(tile.gid, tile.tx, tile.ty);
		}
	}
}

/** Render the component palette + per-object component/depth wiring (M2). */
function renderInspector(host: HTMLElement, components: Component[], objects: EntityType[], level: Level | undefined): void {
	host.replaceChildren();

	const headerCss = "font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#888";
	const wrapCss = "display:flex;flex-wrap:wrap;gap:6px";

	if (components.length > 0) {
		host.appendChild(el("div", headerCss, `Components (${components.length})`));

		const wrap = el("div", wrapCss);

		for (const component of components) {
			const chip = el("span", `${CHIP_CSS};${COMPONENT_COLORS[component.kind]}`);

			chip.appendChild(el("span", "font-weight:600", component.name));
			chip.appendChild(el("span", "opacity:.7;font-size:10px", component.kind === "data" ? component.fields.join(",") : component.kind));
			wrap.appendChild(chip);
		}

		host.appendChild(wrap);
	}

	if (objects.length > 0) {
		host.appendChild(el("div", `${headerCss};margin-top:8px`, `Objects (${objects.length})`));

		for (const object of objects) {
			const row = el("div", "display:flex;align-items:center;gap:8px;padding:6px;border:1px solid #333;border-radius:6px;margin-top:6px");
			const tileset = level?.tilesets.find((entry) => entry.name === object.name);

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

				chips.appendChild(el("span", `${CHIP_CSS};${known !== undefined ? COMPONENT_COLORS[known.kind] : "background:#333;color:#aaa"}`, componentName));
			}

			label.appendChild(chips);
			row.appendChild(label);
			host.appendChild(row);
		}
	}
}

/** Render the system/event sheet: ordered, top-to-bottom rows, each a query (chips) + body as expandable code (M3). */
function renderSystems(host: HTMLElement, systems: System[], components: Component[]): void {
	host.replaceChildren();

	if (systems.length === 0) {
		return;
	}

	host.appendChild(el("div", "font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#888", `Systems — top to bottom, every tick (${systems.length})`));

	for (let index = 0; index < systems.length; index += 1) {
		const system = systems[index];
		const details = document.createElement("details");

		details.style.cssText = "border:1px solid #333;border-radius:6px;overflow:hidden;margin-top:6px";

		const summary = document.createElement("summary");

		summary.style.cssText = "cursor:pointer;padding:7px 9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;list-style:none";
		summary.appendChild(el("span", `${CHIP_CSS};background:#333;color:#aaa;font-variant-numeric:tabular-nums`, String(index + 1)));
		summary.appendChild(el("span", "font-weight:600", system.name));

		const seen = new Set<string>();

		for (const query of system.queries) {
			for (const name of query) {
				seen.add(name);
			}
		}

		if (seen.size > 0) {
			summary.appendChild(el("span", "color:#777;font-size:11px", "for each"));

			for (const name of seen) {
				const known = components.find((entry) => entry.name === name);

				summary.appendChild(el("span", `${CHIP_CSS};${known !== undefined ? COMPONENT_COLORS[known.kind] : "background:#333;color:#aaa"}`, name));
			}
		}

		details.appendChild(summary);

		const pre = document.createElement("pre");

		pre.textContent = system.body || "// (source not found)";
		pre.style.cssText = "margin:0;padding:9px;border-top:1px solid #333;background:#161616;color:#c8c8c8;font:11px/1.5 ui-monospace,monospace;overflow:auto;white-space:pre";
		details.appendChild(pre);
		host.appendChild(details);
	}
}

// ── the view ────────────────────────────────────────────────────────────────────────────────────────────────
export function installGameView(getApi: () => Api, hub: Hub): void {
	// Lazily spawn the parse worker + wire its hub into the workbench hub on first render (so BABLR only loads when
	// the view is actually used, and its logs/RPC federate over the one link). `ready` resolves on the worker's
	// `game.ready` — the client must not request before `serve` is registered + advertised, or the fire-and-forget
	// hub drops the request (the "no responder" timeout). A timeout fallback keeps us from hanging if it's missed.
	let rpc: ReturnType<typeof createRpcClient> | undefined;
	let ready: Promise<void> | undefined;

	const ensureWorker = async (): Promise<ReturnType<typeof createRpcClient>> => {
		if (rpc === undefined) {
			const worker = new Worker(new URL("./lsp/game-worker.js", location.href), { "type": "module" });

			worker.addEventListener("error", (event) => { console.error("[game-worker] load error:", event.message); });
			ready = new Promise<void>((resolve) => {
				const off = hub.subscribe("game.ready", () => { off(); resolve(); });

				setTimeout(resolve, 4000); // fallback: proceed even if the ready ping was missed
			});
			hub.link(portTransport(worker));
			rpc = createRpcClient(hub);
		}

		await ready;

		return rpc;
	};

	registerCustomView({
		"id": "gameMaker.level",
		"name": "Level",
		"order": 1,
		"location": ViewContainerLocation.AuxiliaryBar,
		"renderBody": (container: HTMLElement) => {
			container.style.cssText = "height:100%;display:flex;flex-direction:column;background:#1e1e1e;color:#ccc;font:12px system-ui,sans-serif";

			const status = el("div", "padding:6px 10px;border-bottom:1px solid #333;flex:0 0 auto", "Open a Tilemap level file (e.g. levels/level1.ts) to see it here.");
			const scroll = el("div", "flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:12px");
			const canvas = document.createElement("canvas");

			canvas.style.cssText = "image-rendering:pixelated;background:#000;max-width:100%;box-shadow:0 0 0 1px #333;flex:0 0 auto;align-self:center;display:none";

			const inspector = el("div", "display:flex;flex-direction:column");
			const systems = el("div", "display:flex;flex-direction:column");

			scroll.append(canvas, inspector, systems);
			container.append(status, scroll);

			let token = 0;

			async function render(): Promise<void> {
				token += 1;
				const mine = token;
				const api = getApi();
				const editor = api?.window?.activeTextEditor;
				const code: string | undefined = editor?.document?.getText();

				if (code === undefined || !code.includes("new Tilemap(")) {
					status.textContent = "Open a Tilemap level file (e.g. levels/level1.ts) to see it here.";
					canvas.style.display = "none";
					inspector.replaceChildren();
					systems.replaceChildren();

					return;
				}

				const sources = await gatherSources(api, editor.document.uri, code);

				if (mine !== token) {
					return;
				}

				let projection: GameProjection;

				try {
					const client = await ensureWorker();

					projection = await client.request("game.project", sources, { "timeoutMs": 20000 }) as GameProjection;
				} catch (error) {
					status.textContent = "Parse failed: " + (error instanceof Error ? error.message : String(error));

					return;
				}

				if (mine !== token) {
					return;
				}

				const { level, components, objects, systems: systemList } = projection;

				renderInspector(inspector, components, objects, level);
				renderSystems(systems, systemList, components);

				if (level === undefined) {
					canvas.style.display = "none";
					status.textContent = "Could not parse a Tilemap level from this file.";

					return;
				}

				const images = await loadImages(level.tilesets);

				if (mine !== token) {
					return;
				}

				canvas.style.display = "block";
				renderLevelCanvas(canvas, level, images);

				const fileName = String(editor.document.uri.path).split("/").pop();

				status.textContent = `${fileName} — ${level.width}×${level.height}, ${level.tilesets.length} tilesets, ${level.layers.length} layers`;
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
