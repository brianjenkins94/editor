/**
 * The outer SHELL — the app's main layout. When index.html loads at the TOP level, main.tsx calls `renderShell()`
 * (instead of booting the workbench): it builds the surrounding chrome — a top icon bar, a collapsible LHS project
 * picker, the editor filling the middle, a collapsible RHS revision-history panel — and iframes the SAME page back
 * in. That nested instance sees `window.parent !== window`, so main.tsx takes the APP path and boots the workbench,
 * which fills the middle (fill mode). One entry, one bundle, one COI bootstrap; the shell↔app seam is the hub.
 *
 * The picker talks to the app over the hub: the app `serve`s `project.list` and subscribes `project.open` (main.tsx);
 * here we link a shell hub to the app iframe, pull the catalog, and publish the selected id. File contents never
 * cross this channel — the catalog lives app-side (samples.ts); we send only ids.
 */
import { createHub, createRpcClient, windowTransport } from "@brianjenkins94/hub";

interface SampleInfo { "id": string; "name": string; "description": string }

const STYLES = `
:root {
  --bg: #181818; --chrome: #202020; --line: #2d2d2d; --fg: #d4d4d4; --muted: #8a8a8a;
  --accent: #3794ff; --top-h: 40px; --side-w: 260px; --rail: 44px;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif; }
.shell { display: grid; height: 100%;
  grid-template-rows: var(--top-h) 1fr;
  grid-template-columns: var(--side-w) 1fr var(--side-w);
  grid-template-areas: "top top top" "lhs editor rhs"; }
.shell[data-lhs="collapsed"] { grid-template-columns: var(--rail) 1fr var(--side-w); }
.shell[data-rhs="collapsed"] { grid-template-columns: var(--side-w) 1fr var(--rail); }
.shell[data-lhs="collapsed"][data-rhs="collapsed"] { grid-template-columns: var(--rail) 1fr var(--rail); }
.shell .top { grid-area: top; background: var(--chrome); border-bottom: 1px solid var(--line);
  display: flex; align-items: center; gap: 4px; padding: 0 8px; }
.shell .top .title { font-weight: 600; margin-right: 10px; color: var(--muted); }
.shell .iconbtn { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent;
  color: var(--fg); cursor: pointer; font-size: 15px; display: grid; place-items: center; }
.shell .iconbtn:hover { background: #ffffff14; }
.shell .top .spacer { flex: 1; }
.shell .panel { background: var(--chrome); overflow: hidden; display: flex; flex-direction: column; }
.shell .lhs { grid-area: lhs; border-right: 1px solid var(--line); }
.shell .rhs { grid-area: rhs; border-left: 1px solid var(--line); }
.shell .panel .head { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--line); text-transform: uppercase; font-size: 11px;
  letter-spacing: .06em; color: var(--muted); }
.shell .panel .head .label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shell .panel .body { flex: 1; overflow: auto; padding: 10px; color: var(--muted); }
.shell[data-lhs="collapsed"] .lhs .label, .shell[data-lhs="collapsed"] .lhs .body,
.shell[data-rhs="collapsed"] .rhs .label, .shell[data-rhs="collapsed"] .rhs .body { display: none; }
.shell .editor { grid-area: editor; position: relative; background: #1e1e1e; }
.shell .editor iframe { width: 100%; height: 100%; border: 0; display: block; }
.shell .picker { display: flex; flex-direction: column; gap: 6px; }
.shell .proj { text-align: left; border: 1px solid var(--line); background: #ffffff08; color: var(--fg);
  border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.shell .proj:hover { background: #ffffff14; border-color: #ffffff2e; }
.shell .proj[aria-current="true"] { border-color: var(--accent); background: #3794ff1f; }
.shell .proj .n { font-weight: 600; display: block; }
.shell .proj .d { font-size: 11px; color: var(--muted); display: block; margin-top: 2px; }
`;

const MARKUP = `
<div class="shell" id="shell" data-lhs="expanded" data-rhs="expanded">
  <div class="top">
    <span class="title">editor</span>
    <button class="iconbtn" data-toggle="lhs" title="Toggle project panel">▐</button>
    <button class="iconbtn" title="Open project">📁</button>
    <button class="iconbtn" title="Run">▶</button>
    <button class="iconbtn" title="Commit">⤴</button>
    <span class="spacer"></span>
    <button class="iconbtn" title="History">🕑</button>
    <button class="iconbtn" data-toggle="rhs" title="Toggle history panel">▌</button>
  </div>
  <aside class="panel lhs">
    <div class="head"><span class="label">Projects</span>
      <button class="iconbtn" data-toggle="lhs" title="Collapse">‹</button></div>
    <div class="body"><div id="picker" class="picker">Connecting to editor…</div></div>
  </aside>
  <main class="editor"><iframe id="app-frame" title="editor" allow="cross-origin-isolated"></iframe></main>
  <aside class="panel rhs">
    <div class="head"><span class="label">History</span>
      <button class="iconbtn" data-toggle="rhs" title="Collapse">›</button></div>
    <div class="body">Revision history — coming soon.</div>
  </aside>
</div>
`;

/** Build the shell chrome, iframe the app, and wire the LHS picker over the hub. */
export function renderShell(): void {
	const style = document.createElement("style");

	style.textContent = STYLES;
	document.head.appendChild(style);
	document.body.innerHTML = MARKUP;

	const shell = document.getElementById("shell")!;
	const appFrame = document.getElementById("app-frame") as HTMLIFrameElement;
	const pickerEl = document.getElementById("picker")!;

	// Collapsible panels: toggling a side reflows the grid; the app iframe reflows WITHOUT reloading (verified).
	for (const button of shell.querySelectorAll<HTMLElement>("[data-toggle]")) {
		button.addEventListener("click", () => {
			const side = button.dataset["toggle"]!;

			shell.dataset[side] = shell.dataset[side] === "collapsed" ? "expanded" : "collapsed";
		});
	}

	// Load the SAME page into the iframe; that instance sees `window.parent !== window` → main.tsx boots the app.
	appFrame.src = location.href;

	// The shell hub, linked to the app iframe. The app serves `project.list` and subscribes `project.open`.
	const shellHub = createHub({ "id": "shell" });

	shellHub.link(windowTransport(appFrame.contentWindow!));

	const rpc = createRpcClient(shellHub);
	let currentId: string | undefined;

	const renderPicker = (samples: SampleInfo[]): void => {
		pickerEl.innerHTML = "";

		for (const sample of samples) {
			const button = document.createElement("button");

			button.className = "proj";
			button.setAttribute("aria-current", String(sample.id === currentId));
			button.innerHTML = `<span class="n"></span><span class="d"></span>`;
			button.querySelector<HTMLElement>(".n")!.textContent = sample.name;
			button.querySelector<HTMLElement>(".d")!.textContent = sample.description;
			button.addEventListener("click", () => {
				currentId = sample.id;
				shellHub.publish("project.open", { "id": sample.id });

				for (const el of pickerEl.querySelectorAll<HTMLElement>(".proj")) {
					el.setAttribute("aria-current", "false");
				}

				button.setAttribute("aria-current", "true");
			});
			pickerEl.appendChild(button);
		}
	};

	// Pull the catalog, retrying until the app iframe has linked (the hub's hello handshake reconciles interest).
	void (async (): Promise<void> => {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				const samples = await rpc.request("project.list", undefined, { "timeoutMs": 2000 }) as SampleInfo[];

				if (Array.isArray(samples) && samples.length > 0) {
					renderPicker(samples);

					return;
				}
			} catch { /* app not linked yet — retry */ }

			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		pickerEl.textContent = "Could not reach the editor.";
	})();
}
