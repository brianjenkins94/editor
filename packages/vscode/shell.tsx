/** @jsxImportSource preact */
/**
 * The outer SHELL — the app's main layout, built on Web Awesome's `<wa-page>` app-shell (header / navigation / main /
 * aside), so the chrome is components + theme tokens with almost no hand-rolled layout CSS.
 *
 * When index.html loads at the TOP level, main.tsx calls `renderShell()` (dynamically, so this WA chunk never loads in
 * the editor iframe). It renders the chrome and iframes THIS same page back into the `main` region; that nested
 * instance sees `window.parent !== window` and takes the app branch, booting the workbench into it (fill mode). One
 * entry, one bundle; the shell↔app seam is the hub.
 *
 * The picker talks to the app over the hub: the app `serve`s `project.list` and subscribes `project.open` (main.tsx);
 * here we link a shell hub to the app iframe, pull the catalog, and publish the selected id. File contents never cross
 * this channel — the catalog lives app-side (samples.ts); we send only ids. The RHS review panel (git-panel.ts) is
 * mounted into the `aside` region as-is; its WA rebuild is a follow-on.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createHub, createRpcClient, windowTransport } from "@brianjenkins94/hub";
import { ChevronLeft, ChevronRight, FolderOpen, GitCommit, History, Play, PanelLeft, PanelRight } from "lucide";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { renderGitPanel } from "./git-panel";
import { installShellPreview } from "./shell-preview";
import { css, globalCss, iconSvg } from "./theme";
import "@awesome.me/webawesome/dist/components/page/page.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "./webawesome";
import "theme"; // our brand tokens, layered on Web Awesome's default theme (must come after it)

interface SampleInfo { "id": string; "name": string; "description": string }

// Structural CSS — the little that wa-page doesn't give us: full-viewport height, the editor iframe filling `main`,
// the diff overlay, and the collapse widths. All via theme tokens (stitches objects, not CSS strings).
const injectGlobals = globalCss({
	// Legacy CSS vars the (kept) git-panel.ts still references — mapped onto WA tokens so it follows light/dark too,
	// until its own WA rebuild.
	":root": {
		"--bg": "var(--wa-color-surface-default)",
		"--chrome": "var(--wa-color-surface-raised)",
		"--line": "var(--wa-color-surface-border)",
		"--fg": "var(--wa-color-text-normal)",
		"--muted": "var(--wa-color-text-quiet)",
		"--accent": "var(--wa-color-brand-fill-loud)"
	},
	"html, body": { "height": "100%", "margin": 0 },
	"body": { "backgroundColor": "var(--wa-color-surface-default)", "color": "var(--wa-color-text-normal)", "fontFamily": "var(--wa-font-family-body, system-ui, sans-serif)" },
	// The shell fills the viewport; its menu/aside widths are theme-driven and collapse to 0 via the classes below.
	".wa-shell": { "height": "100vh", "--menu-width": "260px", "--aside-width": "380px" },
	".wa-shell.lhs-collapsed": { "--menu-width": "0px" },
	".wa-shell.rhs-collapsed": { "--aside-width": "0px" }
});

// The top bar: branding + icon actions, spread across the header. wa-button (plain) for every control.
const topBar = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-2xs)", "padding": "0 var(--wa-space-s)", "height": "40px" });
const brand = css({ "fontWeight": "var(--wa-font-weight-semibold)", "marginInlineEnd": "var(--wa-space-s)", "color": "var(--wa-color-text-quiet)" });
const spacer = css({ "flex": "1 1 auto" });

// The menu/aside regions are full-height flex columns: a fixed header strip, then a scrolling body — so the projects
// list and the (kept) git-panel each fill their side and scroll internally. `--header-height` is published by wa-page.
const sideCol = css({ "height": "calc(100dvh - var(--header-height, 40px))", "display": "flex", "flexDirection": "column", "minHeight": 0 });
const sideBody = css({ "flex": "1 1 0", "minHeight": 0, "overflowY": "auto" });
const sideHost = css({ "flex": "1 1 0", "minHeight": 0 });

// Navigation (projects) region.
const navHead = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-2xs)", "padding": "var(--wa-space-2xs) var(--wa-space-xs)", "textTransform": "uppercase", "fontSize": "11px", "letterSpacing": "0.06em", "color": "var(--wa-color-text-quiet)", "flex": "0 0 auto" });
const navHeadLabel = css({ "flex": "1 1 auto" });
const picker = css({ "display": "flex", "flexDirection": "column", "gap": "var(--wa-space-2xs)", "padding": "var(--wa-space-xs)" });
const projectCard = css({
	"cursor": "pointer",
	"--spacing": "var(--wa-space-xs)",
	"&::part(body)": { "display": "block" },
	"&:hover::part(body)": { "backgroundColor": "var(--wa-color-neutral-fill-quiet)" },
	"&:focus-visible": { "outline": "2px solid var(--wa-color-focus)", "outlineOffset": "1px" },
	"&.selected::part(body)": { "backgroundColor": "var(--wa-color-brand-fill-quiet)" },
	"&.selected": { "borderInlineStart": "2px solid var(--wa-color-brand-fill-loud)" }
});
const projectName = css({ "display": "block", "fontWeight": "var(--wa-font-weight-semibold)" });
const projectDesc = css({ "display": "block", "fontSize": "11px", "color": "var(--wa-color-text-quiet)", "marginBlockStart": "2px", "whiteSpace": "normal" });

// The editor iframe fills the `main` region; the diff overlay covers it when a file is opened.
const appFrame = css({ "width": "100%", "height": "100%", "border": 0, "display": "block" });
const mainWrap = css({ "position": "relative", "height": "100%" });
const overlay = css({
	"position": "absolute", "inset": 0, "zIndex": 20, "display": "none", "flexDirection": "column",
	"backgroundColor": "var(--wa-color-surface-default)",
	"&.open": { "display": "flex" }
});
const overlayHead = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-2xs)", "height": "34px", "padding": "0 var(--wa-space-2xs) 0 var(--wa-space-s)", "borderBottom": "1px solid var(--wa-color-surface-border)", "flex": "0 0 auto" });
const overlayTitle = css({ "flex": "1 1 auto", "fontFamily": "var(--wa-font-family-code, monospace)", "fontSize": "12px", "whiteSpace": "nowrap", "overflow": "hidden", "textOverflow": "ellipsis" });
const overlayBody = css({ "flex": "1 1 auto", "overflow": "auto", "minHeight": 0 });

/** A lucide icon rendered into a Web Awesome button. */
function Icon({ node }: { "node": Parameters<typeof iconSvg>[0] }) {
	return <span dangerouslySetInnerHTML={{ "__html": iconSvg(node, { "size": 17 }) }} />;
}

/** The projects picker — one Web Awesome button per sample, driven by the hub catalog. */
function Picker({ samples, currentId, onOpen }: { "samples": SampleInfo[]; "currentId"?: string; "onOpen": (id: string) => void }) {
	if (samples.length === 0) {
		return <div class={picker()}>Connecting to editor…</div>;
	}

	return (
		<div class={picker()}>
			{samples.map((sample) => (
				<wa-card
					key={sample.id}
					class={projectCard() + (sample.id === currentId ? " selected" : "")}
					role="button"
					tabindex={0}
					aria-current={sample.id === currentId}
					onClick={() => { onOpen(sample.id); }}
					onKeyDown={(event: KeyboardEvent) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onOpen(sample.id);
						}
					}}
				>
					<span class={projectName()}>{sample.name}</span>
					<span class={projectDesc()}>{sample.description}</span>
				</wa-card>
			))}
		</div>
	);
}

/** The shell chrome. Owns the shell hub and, once mounted, links it to the app iframe, mounts the review panel into
 *  the aside, and installs the (top-frame) preview window. */
function Shell() {
	const [lhsCollapsed, setLhsCollapsed] = useState(false);
	const [rhsCollapsed, setRhsCollapsed] = useState(false);
	const [samples, setSamples] = useState<SampleInfo[]>([]);
	const [currentId, setCurrentId] = useState<string | undefined>(undefined);

	const appFrameRef = useRef<HTMLIFrameElement>(null);
	const gitPanelRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const overlayTitleRef = useRef<HTMLSpanElement>(null);
	const overlayBodyRef = useRef<HTMLDivElement>(null);
	const overlayCloseRef = useRef<HTMLElement>(null);
	const hubRef = useRef<Hub>();

	// Mount-once wiring: the shell hub linked to the app iframe, the review panel, and the preview window.
	useEffect(() => {
		const appFrame = appFrameRef.current;

		if (appFrame === null) {
			return;
		}

		// Load the SAME page into the iframe; that instance sees `window.parent !== window` → main.tsx boots the app.
		appFrame.src = location.href;

		const shellHub = createHub({ "id": "shell" });

		hubRef.current = shellHub;
		shellHub.link(windowTransport(appFrame.contentWindow!));

		// The preview window lives in the top frame so it can roam beyond the editor. See shell-preview.ts.
		installShellPreview(shellHub);

		// The editor (workbench iframe) follows the OS theme too. The shell is the source of truth for the OS
		// preference — it reliably gets prefers-color-scheme changes, whereas the iframe may not — so publish the
		// scheme (initially + on change) and let workbench-entry.tsx set the editor theme from it.
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const publishScheme = (): void => { shellHub.publish("theme.colorScheme", { "dark": scheme.matches }); };

		publishScheme();
		scheme.addEventListener("change", publishScheme);

		// The RHS review panel — GitHub-Desktop-style changes + commit; the diff opens in the overlay over the editor.
		renderGitPanel(gitPanelRef.current!, {
			"el": overlayRef.current!,
			"title": overlayTitleRef.current!,
			"body": overlayBodyRef.current!,
			"close": overlayCloseRef.current!
		}, shellHub);

		const rpc = createRpcClient(shellHub);

		// Pull the catalog, retrying until the app iframe has linked (the hub's hello handshake reconciles interest).
		void (async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				try {
					const list = await rpc.request("project.list", undefined, { "timeoutMs": 2000 }) as SampleInfo[];

					if (Array.isArray(list) && list.length > 0) {
						setSamples(list);

						return;
					}
				} catch { /* app not linked yet — retry */ }

				await new Promise((resolve) => { setTimeout(resolve, 500); });
			}
		})();
	}, []);

	const openProject = (id: string): void => {
		setCurrentId(id);
		hubRef.current?.publish("project.open", { "id": id });
	};

	const shellClass = ["wa-shell", lhsCollapsed ? "lhs-collapsed" : "", rhsCollapsed ? "rhs-collapsed" : ""].filter(Boolean).join(" ");

	return (
		<wa-page class={shellClass} mobile-breakpoint="0" disable-navigation-toggle>
			<div slot="header" class={topBar()}>
				<span class={brand()}>editor</span>
				<wa-button appearance="plain" size="small" title="Toggle project panel" aria-label="Toggle project panel" onClick={() => { setLhsCollapsed((value) => !value); }}><Icon node={PanelLeft} /></wa-button>
				<wa-button appearance="plain" size="small" title="Open project" aria-label="Open project"><Icon node={FolderOpen} /></wa-button>
				<wa-button appearance="plain" size="small" title="Run" aria-label="Run"><Icon node={Play} /></wa-button>
				<wa-button appearance="plain" size="small" title="Commit" aria-label="Commit"><Icon node={GitCommit} /></wa-button>
				<span class={spacer()} />
				<wa-button appearance="plain" size="small" title="History" aria-label="History"><Icon node={History} /></wa-button>
				<wa-button appearance="plain" size="small" title="Toggle history panel" aria-label="Toggle history panel" onClick={() => { setRhsCollapsed((value) => !value); }}><Icon node={PanelRight} /></wa-button>
			</div>

			{!lhsCollapsed && (
				<div slot="navigation" class={sideCol()}>
					<div class={navHead()}>
						<span class={navHeadLabel()}>Projects</span>
						<wa-button appearance="plain" size="small" title="Collapse" aria-label="Collapse project panel" onClick={() => { setLhsCollapsed(true); }}><Icon node={ChevronLeft} /></wa-button>
					</div>
					<div class={sideBody()}>
						<Picker samples={samples} currentId={currentId} onOpen={openProject} />
					</div>
				</div>
			)}

			<div class={mainWrap()}>
				<iframe ref={appFrameRef} class={appFrame()} title="editor" allow="cross-origin-isolated" />

				<div ref={overlayRef} class={overlay()}>
					<div class={overlayHead()}>
						<span ref={overlayTitleRef} class={overlayTitle()} />
						<wa-button ref={overlayCloseRef} appearance="plain" size="small" title="Close diff" aria-label="Close diff"><Icon node={ChevronRight} /></wa-button>
					</div>
					{/* `wa-diff-body` scopes the codehike diff grid CSS (git-panel.css). It MUST be declared here in JSX, not
					    added imperatively by git-panel: preact owns this element's `class`, so any Shell re-render would
					    otherwise reconcile it back and wipe an imperatively-added class — collapsing the diff grid. */}
					<div ref={overlayBodyRef} class={overlayBody() + " wa-diff-body"} />
				</div>
			</div>

			{!rhsCollapsed && (
				<div slot="aside" class={sideCol()}>
					<div class={navHead()}>
						<span class={navHeadLabel()}>Changes</span>
						<wa-button appearance="plain" size="small" title="Collapse" aria-label="Collapse changes panel" onClick={() => { setRhsCollapsed(true); }}><Icon node={ChevronRight} /></wa-button>
					</div>
					<div ref={gitPanelRef} class={sideHost()} />
				</div>
			)}
		</wa-page>
	);
}

/** Reflect the OS light/dark preference onto Web Awesome's mode classes (WA switches via `.wa-light` / `.wa-dark`,
 *  not `prefers-color-scheme`), so the shell theme follows the system and updates live when it changes. */
function applySystemColorScheme(): void {
	const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;

	document.documentElement.classList.toggle("wa-dark", dark);
	document.documentElement.classList.toggle("wa-light", !dark);
}

/** Build the shell chrome, iframe the app, and wire the LHS picker over the hub. */
export function renderShell(): void {
	document.documentElement.classList.add("wa-theme-default");
	applySystemColorScheme();
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applySystemColorScheme);
	injectGlobals();
	render(<Shell />, document.body);
}
