/** @jsxImportSource preact */
/**
 * The VS Code workbench shell.
 *
 * Each region (sidebar / editors / panel / auxbar / status bar) is its own small, independently
 * configurable sub-component: it accepts an extra `class` and `children`, so markup or CSS can be
 * layered in as needed without touching the monaco-vscode-api bundle. `<Workbench/>` arranges them in
 * a stitches grid and hands the resolved container elements to `boot()` (via `onReady`), which
 * attaches the real workbench parts into them.
 *
 * Styling is stitches (`theme`), so it shares the palette and injects into this document's head —
 * which works because this whole tree is rendered *inside the iframe* by `workbench-entry.tsx`.
 */
import type { WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";
import type { ComponentChildren, Ref } from "preact";
import { Bug, Files, Search } from "lucide";
import { useState } from "preact/hooks";
import { css, globalCss, iconSvg } from "./theme";

const shell = css({
	"display": "grid",
	"height": "100%",
	// 5px "handle" tracks sit between sidebar/editors/auxbar and above the console (panel). Like VS Code's
	// sashes they're invisible at rest (the resting dividers are monaco's own part borders) and reveal a
	// `sash.hoverBorder` line on hover — the pure-CSS resize controls below drive them. The 5px track is the
	// (wide) grab zone; on hover the handle's `::before` fills it. The region's native resize grip (a
	// `::-webkit-resizer` stretched 100× by the region's `scale`) is made transparent (see injectControls) so
	// the handle above can be transparent instead of an opaque mask. The region sits under the panels, so only
	// this exposed track is hittable — hence 5px, not 1px. Console spans full width.
	// The resizable tracks (sidebar/auxbar columns, console row) are `max-content`, so a control's
	// hidden `.region` drives them: the region fills its area (`min-width/height:100%`, so its native
	// resize grip sits ON the handle strip — not buried under the part) and dragging it past the
	// part's size grows the `max-content` track. Editors column + main row are `1fr` and absorb the
	// slack. Resize is GROW-only: dragging inward clamps at 100% and the part floors the track.
	"gridTemplate": `
		"header       header         header         header         header"         min-content
		"sidebar      sidebar-handle editors        auxbar-handle  auxbar"         1fr
		"sidebar      sidebar-handle console-handle console-handle console-handle" 5px
		"sidebar      sidebar-handle console        console        console"        max-content
		"footer       footer         footer         footer         footer"         min-content
		/ max-content 5px            1fr            5px            max-content`
});

function region(area: string, extra: Record<string, unknown> = {}) {
	return css({ "gridArea": area, "zIndex": 1, ...extra });
}

const headerCss = region("header");
// Sidebar area = our own 48px activity bar (icon switcher) laid beside the real sidebar part.
const sidebarCss = region("sidebar", { "display": "flex", "backgroundColor": "var(--vscode-sideBar-background)" });
// The activity bar: a darker (editor-bg) strip of icon buttons that switch the sidebar viewlet.
const activityBarCss = css({ "flex": "0 0 48px", "display": "flex", "flexDirection": "column", "backgroundColor": "var(--vscode-editor-background)", "zIndex": 1 });
const activityItemCss = css({
	"height": 48,
	"display": "flex",
	"alignItems": "center",
	"justifyContent": "center",
	"padding": 0,
	"background": "transparent",
	"border": "none",
	"borderLeft": "2px solid transparent",   // active indicator slot (keeps icons from shifting)
	"color": "var(--vscode-icon-foreground)",   // solid gray (opaque — not the translucent inactiveForeground that looked blurry)
	"cursor": "pointer",
	"transition": "color 0.1s ease",
	"&:hover": { "color": "var(--vscode-activityBar-foreground)" },   // brighten on hover
	"&.active": { "color": "var(--vscode-activityBar-foreground)", "borderLeftColor": "var(--vscode-activityBar-activeBorder)" },   // active brightens to white + left bar
	"& svg": { "display": "block", "width": 24, "height": 24 }   // iconSvg uses currentColor → driven by `color`
});
// The real sidebar part attaches into this; it fills the space beside the activity bar.
const sidebarPartCss = css({ "flex": "1 1 auto", "minWidth": 0, "position": "relative" });
const editorsCss = region("editors");
const consoleCss = region("console");
const auxbarCss = region("auxbar", { "display": "block !important" });
const footerCss = region("footer");

// Monaco injects its parts *inside* the containers below; make them fill their region.
const injectGlobals = globalCss({
	// VS Code scopes the UI font to `.monaco-workbench-part` descendants only, so body-level
	// overlays (context menus, the command palette) — which render in a bare `.context-view`
	// appended to the body — miss it and fall back to the browser's serif default. Set the
	// platform font on the workbench root (the body) so it cascades to those too. The editor
	// sets its own monospace font explicitly, so this doesn't affect it.
	".monaco-workbench.mac": { "fontFamily": "-apple-system, BlinkMacSystemFont, sans-serif" },
	".monaco-workbench.windows": { "fontFamily": "\"Segoe WPC\", \"Segoe UI\", sans-serif" },
	".monaco-workbench.linux": { "fontFamily": "system-ui, \"Ubuntu\", \"Droid Sans\", sans-serif" },
	"[id^=\"workbench.parts.\"]": { "height": "100%" },
	"[id^=\"workbench.parts.\"] > .content": { "height": "100% !important", "width": "100% !important" }
});

// Pure-CSS resize controls (faithful port of the original layout — no JS). Each divider is a thin
// grid "handle" track; a hidden native-`resize` `.region` is transformed to overlap that strip, so
// dragging it resizes the adjacent part. `display:contents` lets each control's region + handle act
// as direct grid items. The drag reaches the region beneath the handle (handle is pointer-events:none).
// The region's `scale`/`translate` map the tiny native resize grip onto the whole handle strip and flip
// it so it grips from the correct edge.
//
// The VS Code sash look: the vertical handle tracks (sidebar/auxbar) are transparent and draw NOTHING at
// rest — the resting dividers there are monaco's own part borders (per the theme), so they're never doubled.
// The console handle is the exception: it paints its strip like the panel and carries the panel's top border
// itself (see below), because the 5px grab track would otherwise leave a visible gap above the panel.
// On hover the handle's `::before` expands from a collapsed 1px to fill the full 5px track with
// `sash.hoverBorder`, then fades back on leave — matching VS Code's hover reveal. The region's
// `::-webkit-resizer` grip is painted transparent so the handle needn't be an opaque mask. Scoped under
// `.wb-shell`.
const injectControls = globalCss({
	".wb-shell .sidebar-control": { "display": "contents" },
	".wb-shell .console-control": { "display": "contents" },
	".wb-shell .auxbar-control": { "display": "contents" },

	// Hide the native resize grip (visual only — the region stays draggable) so transparent handles can
	// sit over it without exposing the grip artifact.
	".wb-shell .region::-webkit-resizer": { "backgroundColor": "transparent" },

	// Handles: grab-zone tracks (transparent for the vertical sashes; the console strip is panel-painted
	// below). The visible sash is the `::before` line on each.
	// Vertical sashes sit at z-index 11 — one above the console handle (10) so their hover line paints OVER
	// the panel-coloured console strip where the two cross, instead of being notched out by it.
	".wb-shell .sidebar-control > .handle": { "gridArea": "sidebar-handle", "position": "relative", "zIndex": 11, "pointerEvents": "none" },
	// The console handle also paints its 5px strip with the panel background and reaches 5px further left (over
	// the sidebar-handle column). This visually pulls the panel's top edge up flush under the editor and left
	// flush against the sidebar WITHOUT moving the panel part — so the resize region and panel clicks are
	// untouched. Monaco's own panel-top border is hidden below (it would sit 5px lower); the flush divider is
	// the handle's ::before instead.
	".wb-shell .console-control > .handle": { "gridArea": "console-handle", "position": "relative", "zIndex": 10, "pointerEvents": "none", "marginLeft": -5, "backgroundColor": "var(--vscode-panel-background)" },
	".wb-shell .auxbar-control > .handle": { "gridArea": "auxbar-handle", "position": "relative", "zIndex": 11, "pointerEvents": "none" },

	// The sash line is drawn only on hover — at rest the handle is fully transparent and monaco's own part
	// borders (side-bar / panel / editor-group, per the theme) are the dividers, so we never double them up.
	// Vertical sashes (sidebar, auxbar): the `::before` collapses to a centered 1px at rest (invisible) and
	// expands to fill the full 5px track with `sash.hoverBorder` on hover — matching VS Code, where the hover
	// highlight spans the whole sash.
	".wb-shell .sidebar-control > .handle::before": { "content": "\"\"", "position": "absolute", "top": 0, "bottom": 0, "left": "50%", "width": "1px", "transform": "translateX(-50%)", "backgroundColor": "transparent", "transition": "width 0.08s ease, background-color 0.08s ease" },
	".wb-shell .auxbar-control > .handle::before": { "content": "\"\"", "position": "absolute", "top": 0, "bottom": 0, "left": "50%", "width": "1px", "transform": "translateX(-50%)", "backgroundColor": "transparent", "transition": "width 0.08s ease, background-color 0.08s ease" },
	".wb-shell .sidebar-control:hover > .handle::before": { "width": "100%", "backgroundColor": "var(--vscode-sash-hoverBorder)" },
	".wb-shell .auxbar-control:hover > .handle::before": { "width": "100%", "backgroundColor": "var(--vscode-sash-hoverBorder)" },

	// Horizontal sash (console): the resting divider is a 1px `panel-border` line at the TOP of the strip
	// (flush under the editor), not centered — since the strip is panel-coloured, this reads as the panel's
	// own top border. On hover it fills the whole strip with `sash.hoverBorder`.
	".wb-shell .console-control > .handle::before": { "content": "\"\"", "position": "absolute", "left": 0, "right": 0, "top": 0, "height": "1px", "backgroundColor": "var(--vscode-panel-border, transparent)", "transition": "height 0.08s ease, background-color 0.08s ease" },
	".wb-shell .console-control:hover > .handle::before": { "height": "100%", "backgroundColor": "var(--vscode-sash-hoverBorder)" },

	// Hide monaco's own panel-top border — it sits 5px below our flush divider and would read as a second line.
	".wb-shell [id^=\"workbench.parts.panel\"] .composite.title": { "borderTopColor": "transparent !important" },

	// Regions keep the default stacking (region()'s z-index 1 for the parts; these regions sit below them so
	// the parts stay clickable, with only the region's resize grip exposed on the handle strip).
	".wb-shell .sidebar-control > .region": { "gridArea": "sidebar / sidebar / sidebar-handle / sidebar-handle", "minWidth": "100%", "overflow": "hidden", "resize": "horizontal", "transformOrigin": "bottom right", "scale": "1 100" },
	".wb-shell .console-control > .region": { "gridArea": "console-handle / console-handle / console / console", "minHeight": "100%", "maxHeight": "80vh", "overflow": "hidden", "resize": "vertical", "transformOrigin": "bottom right", "scale": "-100 -1", "translate": "-100% -100%" },
	".wb-shell .auxbar-control > .region": { "gridArea": "auxbar-handle / auxbar-handle / auxbar / auxbar", "minWidth": "100%", "overflow": "hidden", "resize": "horizontal", "transformOrigin": "bottom left", "scale": "-1 100", "translate": "100% 0" }
});

const cx = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

interface RegionProps {
	/** Ref to the container the corresponding workbench part attaches into. */
	"containerRef"?: Ref<HTMLElement>;
	/** Extra class(es) to layer on. */
	"class"?: string;
	"children"?: ComponentChildren;
}

export function Header({ "class": className, children }: Omit<RegionProps, "containerRef">) {
	return <header class={cx(headerCss(), className)}>{children}</header>;
}

/** The icon buttons that switch the sidebar viewlet (Explorer / Search / Run & Debug). Clicking runs
 *  the matching VS Code `workbench.view.*` command via the per-extension API the consumer passes in. */
const ACTIVITY_ITEMS = [
	{ "id": "explorer", "title": "Explorer", "icon": Files, "command": "workbench.view.explorer" },
	{ "id": "search", "title": "Search", "icon": Search, "command": "workbench.view.search" },
	{ "id": "debug", "title": "Run and Debug", "icon": Bug, "command": "workbench.view.debug" }
] as const;

function ActivityBar({ runCommand }: { "runCommand": (command: string) => void }) {
	const [active, setActive] = useState<string>(ACTIVITY_ITEMS[0].id);

	return (
		<div class={activityBarCss()}>
			{ACTIVITY_ITEMS.map((item) => (
				<button
					key={item.id}
					type="button"
					class={cx(activityItemCss(), active === item.id ? "active" : "")}
					title={item.title}
					aria-label={item.title}
					onClick={() => {
						setActive(item.id);
						runCommand(item.command);
					}}
					dangerouslySetInnerHTML={{ "__html": iconSvg(item.icon, { "size": 24 }) }}
				/>
			))}
		</div>
	);
}

export function Sidebar({ containerRef, "class": className, children, runCommand }: RegionProps & { "runCommand": (command: string) => void }) {
	return (
		<nav class={cx(sidebarCss(), className)}>
			<ActivityBar runCommand={runCommand} />

			<div class={sidebarPartCss()} ref={containerRef}>{children}</div>
		</nav>
	);
}

export function Editors({ containerRef, "class": className, children }: RegionProps) {
	return <section class={cx(editorsCss(), className)} ref={containerRef}>{children}</section>;
}

export function Console({ containerRef, "class": className, children }: RegionProps) {
	return <section class={cx(consoleCss(), className)} ref={containerRef}>{children}</section>;
}

export function Auxbar({ containerRef, "class": className, children }: RegionProps) {
	return <aside class={cx(auxbarCss(), className)} ref={containerRef}>{children}</aside>;
}

export function StatusBar({ containerRef, "class": className, children }: RegionProps) {
	return (
		<footer class={cx(footerCss(), className)}>
			<div ref={containerRef}>{children}</div>
		</footer>
	);
}

/**
 * Compose the default layout and report the five part containers once all are mounted.
 * Swap/extend the regions here (or pass `class`/`children` into them) to customise the shell.
 */
export function Workbench({ onReady, runCommand }: { "onReady": (parts: WorkbenchParts) => void; "runCommand": (command: string) => void }) {
	injectGlobals();
	injectControls();

	const parts: Partial<WorkbenchParts> = {};
	const collect = (key: keyof WorkbenchParts) => (element: HTMLElement | null) => {
		if (element === null) {
			return;
		}

		parts[key] = element;
		if (parts.sidebar && parts.editors && parts.panel && parts.statusbar && parts.auxbar) {
			onReady(parts);
		}
	};

	// Each part is followed by its resize control (region + handle); the handle is the draggable
	// divider, the region the hidden native-resize element beneath it. DOM order matches the grid.
	return (
		<main class={`wb-shell ${shell()}`}>
			<Header />

			<Sidebar containerRef={collect("sidebar")} runCommand={runCommand} />

			<div class="sidebar-control">
				<div class="region" />

				<div class="handle" />
			</div>

			<Editors containerRef={collect("editors")} />

			<Console containerRef={collect("panel")} />

			<div class="console-control">
				<div class="region" />

				<div class="handle" />
			</div>

			<Auxbar containerRef={collect("auxbar")} />

			<div class="auxbar-control">
				<div class="region" />

				<div class="handle" />
			</div>

			<StatusBar containerRef={collect("statusbar")} />
		</main>
	);
}
