/**
 * theme/app-window — `<app-window>`, a movable, collapsible window (PLAN.md §8.2, §10): Web Awesome's buttons in a frame
 * of the theme's, and `appWindow()`, the same as a function. Published as components/app-window.
 *
 *     <app-window label="Preview" storage-key="preview" closable>
 *       <div slot="header-actions">…</div>
 *       <div>the body</div>
 *     </app-window>
 *
 *     appWindow({ "label": "Preview", "storageKey": "preview", "headerActions": [toolbar], "children": [body], "onClose": close });
 *
 * Light DOM, not a shadow root, so utilities, recipes and a use-site override cascade into it, and any framework can
 * render it: it adds its own chrome (the title, its drag handle; the collapse and close controls) as children and never
 * moves the ones it's given, so Preact's or React's nodes stay where they put them. A grid places everything: the
 * chrome and `slot="header-actions"` children in the header row, the rest in the body, one over another.
 *
 * Its attributes, slots and events are `definition`'s; `initial-left` / `initial-top` are also properties, for code that
 * sets them before it's connected. Tokens: `--app-window-z`, `--app-window-padding`, `--app-window-body-height` (what
 * `body-height` sets). Its controls are Web Awesome's buttons where `wa-button` is registered (theme/components/button,
 * which this doesn't import, so the published one needn't have Web Awesome), and native ones where it isn't; its frame
 * reads Web Awesome's tokens' defaults where its theme isn't loaded.
 */
import { component, webAwesomeOr } from "./component";
import { recipe } from "./stitches";

/** What it takes and fires: its custom-elements.json and `appWindow()`'s options are made from this. */
export const definition = {
	"tag": "app-window",
	"attributes": {
		"label": "Its title.",
		"closable": "Shows a close control, which fires app-close.",
		"collapsed": "Only its title bar shows (reflected).",
		"width": "Its width, in px.",
		"body-height": "Its body's height, in px.",
		"storage-key": "Keeps its place, and whether it's collapsed, under this key.",
		"initial-left": "Where it opens with no place saved: px from the left (default: centred).",
		"initial-top": "Where it opens with no place saved: px from the top (default: centred)."
	},
	"slots": {
		"header-actions": "Controls in its title bar, before its own.",
		"": "Its body: one element (the window gives it its size; more than one are laid one over another)."
	},
	"events": {
		"app-close": "Its close control was clicked.",
		"app-collapse": "It was collapsed or expanded."
	}
} as const;

const frame = recipe({
	"position": "fixed",
	"zIndex": "var(--app-window-z, 2147483000)",
	"maxWidth": "calc(100vw - var(--wa-space-m))",
	"maxHeight": "calc(100vh - var(--wa-space-m))",
	"display": "grid",
	"gridTemplateColumns": "minmax(0, 1fr) auto auto",
	"gridTemplateRows": "auto var(--app-window-body-height, minmax(0, 1fr))",
	"gridTemplateAreas": "\"title actions controls\" \"body body body\"",
	"boxSizing": "border-box",
	"overflow": "hidden",
	"background": "var(--wa-color-surface-raised)",
	"border": "var(--wa-panel-border-width) var(--wa-panel-border-style) var(--wa-color-surface-border)",
	"borderRadius": "var(--wa-panel-border-radius)",
	"boxShadow": "var(--wa-shadow-l)",
	"& > *": { "gridArea": "body", "minWidth": 0, "minHeight": 0, "padding": "var(--app-window-padding, var(--wa-space-s))", "overflow": "hidden" },
	"& > * > iframe": { "display": "block", "border": 0, "width": "100%", "height": "100%" },
	"& > .app-window-title, & > [slot=header-actions], & > .app-window-controls": { "padding": "var(--wa-space-2xs)", "borderBottom": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)", "alignSelf": "stretch", "display": "flex", "alignItems": "center" },
	// The title takes the header's room (all of it a drag handle) and gives it up: a long title truncates.
	"& > .app-window-title": { "gridArea": "title", "paddingInlineStart": "var(--wa-space-s)", "overflow": "hidden", "textOverflow": "ellipsis", "whiteSpace": "nowrap", "fontWeight": "var(--wa-font-weight-semibold)", "cursor": "grab", "userSelect": "none", "touchAction": "none" },
	"& > .app-window-title.dragging": { "cursor": "grabbing" },
	"& > [slot=header-actions], & > .app-window-controls": { "gap": "var(--wa-space-3xs)" },
	"& > [slot=header-actions]": { "gridArea": "actions", "borderInlineEnd": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" },
	"& > [slot=header-actions]:empty": { "display": "none" },
	"& > .app-window-controls": { "gridArea": "controls", "paddingInlineEnd": "var(--wa-space-s)", "--wa-form-control-padding-inline": "var(--wa-space-2xs)" },
	// Without Web Awesome, its controls are native buttons, as plain.
	"& > .app-window-controls > button": { "font": "inherit", "color": "inherit", "background": "none", "border": 0, "borderRadius": "var(--wa-border-radius-s)", "padding": "var(--wa-space-3xs) var(--wa-space-2xs)", "cursor": "pointer" },
	// Collapsed, the body's row is nothing and the frame clips it, whatever display its content is given.
	"&[collapsed]": { "gridTemplateRows": "auto 0" }
});

interface Persisted { "left"?: number; "top"?: number; "collapsed"?: boolean }

const STORE = "wa-win:";

function loadState(key: string | null): Persisted {
	try {
		return key === null ? {} : JSON.parse(localStorage.getItem(STORE + key) ?? "{}") as Persisted;
	} catch {
		return {};
	}
}

function saveState(key: string | null, patch: Persisted): void {
	try {
		if (key !== null) {
			localStorage.setItem(STORE + key, JSON.stringify({ ...loadState(key), ...patch }));
		}
	} catch {
		/* private mode / disabled */
	}
}

export class AppWindow extends HTMLElement {
	public static observedAttributes = ["label", "closable", "collapsed", "width", "body-height"];

	/** Where it opens when it has no place of its own saved. Default: centred. */
	public "initialLeft"?: number;
	public "initialTop"?: number;

	readonly #title = document.createElement("span");
	readonly #controls = document.createElement("div");
	readonly #collapse = webAwesomeOr("wa-button");
	readonly #close = webAwesomeOr("wa-button");
	#placed = false;

	public constructor() {
		super();
		this.#title.className = "app-window-title";
		this.#controls.className = "app-window-controls";

		for (const button of [this.#collapse, this.#close]) {
			button.setAttribute("appearance", "plain");
			button.setAttribute("size", "s");
		}

		this.#collapse.textContent = "–";
		this.#collapse.title = "Collapse";
		this.#close.hidden = true;
		this.#close.title = "Close";
		this.#close.textContent = "✕";
		this.#close.addEventListener("click", () => this.dispatchEvent(new Event("app-close")));
		this.#collapse.addEventListener("click", () => {
			this.collapsed = !this.collapsed;
		});
		this.#title.addEventListener("pointerdown", (event) => {
			this.#drag(event);
		});
		this.#controls.append(this.#collapse, this.#close);
	}

	public get "label"(): string {
		return this.getAttribute("label") ?? "";
	}

	public set "label"(value: string) {
		this.setAttribute("label", value);
	}

	public get "collapsed"(): boolean {
		return this.hasAttribute("collapsed");
	}

	public set "collapsed"(value: boolean) {
		this.toggleAttribute("collapsed", value);
	}

	public get "storageKey"(): string | null {
		return this.getAttribute("storage-key");
	}

	public set "storageKey"(value: string) {
		this.setAttribute("storage-key", value);
	}

	public connectedCallback(): void {
		this.classList.add(frame());

		if (this.#title.parentNode !== this) {
			this.prepend(this.#title, this.#controls);
		}

		if (!this.#placed) {
			const state = loadState(this.storageKey);

			this.#placed = true;
			this.collapsed = state.collapsed ?? this.collapsed;
			const initial = (name: string, property?: number) => property ?? (this.hasAttribute(name) ? Number(this.getAttribute(name)) : undefined);

			this.moveTo(state.left ?? initial("initial-left", this.initialLeft) ?? (window.innerWidth - this.offsetWidth) / 2, state.top ?? initial("initial-top", this.initialTop) ?? (window.innerHeight - this.offsetHeight) / 2 - 24);
		}
	}

	public attributeChangedCallback(name: string): void {
		if (name === "label") {
			this.#title.textContent = this.label;
			this.#title.title = this.label;
		} else if (name === "closable") {
			this.#close.hidden = !this.hasAttribute("closable");
		} else if (name === "width" || name === "body-height") {
			this.#size();
		} else {
			this.#collapse.textContent = this.collapsed ? "+" : "–";
			this.#collapse.title = this.collapsed ? "Expand" : "Collapse";

			if (this.#placed) {
				saveState(this.storageKey, { "collapsed": this.collapsed });
				this.dispatchEvent(new Event("app-collapse"));
			}
		}
	}

	/* eslint-disable webawesome/no-inline-styles -- a window's place and size: per-instance geometry, dragged, saved or given */
	/** Put it at `left`, `top`, kept on screen. */
	public moveTo(left: number, top: number): void {
		this.style.left = Math.max(4, Math.min(left, window.innerWidth - this.offsetWidth - 4)) + "px";
		this.style.top = Math.max(4, Math.min(top, window.innerHeight - 40)) + "px";
	}

	// Its `width` and its body's height (`body-height`), in px: the body's row is that tall, so what's in it has a definite
	// height to measure (an iframe does, at boot).
	#size(): void {
		this.style.width = this.hasAttribute("width") ? this.getAttribute("width") + "px" : "";
		this.style.setProperty("--app-window-body-height", this.hasAttribute("body-height") ? this.getAttribute("body-height") + "px" : null);
	}
	/* eslint-enable webawesome/no-inline-styles */

	// Drag by the title. Pointer capture keeps the gesture even when the cursor outruns it.
	#drag(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}

		const rect = this.getBoundingClientRect();
		const offsetX = event.clientX - rect.left;
		const offsetY = event.clientY - rect.top;
		const title = this.#title;

		title.setPointerCapture(event.pointerId);
		title.classList.add("dragging");

		const move = (moving: PointerEvent): void => {
			this.moveTo(moving.clientX - offsetX, moving.clientY - offsetY);
		};

		const up = (): void => {
			title.classList.remove("dragging");
			title.removeEventListener("pointermove", move);
			title.removeEventListener("pointerup", up);
			saveState(this.storageKey, { "left": Number.parseInt(this.style.left, 10), "top": Number.parseInt(this.style.top, 10) });
		};

		title.addEventListener("pointermove", move);
		title.addEventListener("pointerup", up);
	}
}

if (customElements.get("app-window") === undefined) {
	customElements.define("app-window", AppWindow);
}

/** `<app-window>` from its options, slots and handlers (theme/component). */
export const appWindow = component(definition);

declare global {
	// eslint-disable-next-line ts/naming-convention -- a custom element's tag is hyphenated by spec
	interface HTMLElementTagNameMap { "app-window": AppWindow }
}
