/** @jsxImportSource preact */
/**
 * The outer SHELL — the app's main layout, built on Web Awesome's `<wa-page>` app-shell (header / main / aside), so the
 * chrome is components + theme tokens with almost no hand-rolled layout CSS.
 *
 * When index.html loads at the TOP level, main.tsx calls `renderShell()` (dynamically, so this WA chunk never loads in
 * the editor iframe). It renders the chrome and iframes THIS same page back into the `main` region; that nested
 * instance sees `window.parent !== window` and takes the app branch, booting the workbench into it (fill mode). One
 * entry, one bundle; the shell↔app seam is the hub.
 *
 * This is the shell's core: the page, the dock the editor iframe is the fixed panel of, the shell hub linked to the app,
 * the theme, and the RHS review panel (git-panel.tsx, Web Awesome components of its own) in the `aside` region. Every
 * other part of the top window is a feature (feature.ts): started once the hub is linked, its control placed in the top
 * bar, what it draws over the page drawn — FEATURES, below, is the list.
 */
import type { VsCodeColors } from "theme/vscode-colors";
import type { ShellContext, ShellFeature } from "./feature";
import { createHub, createRpcClient, windowTransport } from "@brianjenkins94/hub";
import { relayLoggerToHub, tapConsoleAndErrors } from "@brianjenkins94/observability";
import { ChevronRight, PanelRight } from "lucide";
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { asidePane, editorFrame, injectGlobals, mainWrap, overlay, overlayBar, overlayBody, overlayTitle, railRegion, resizer, resizerLeft, sideCol, sideHost, spacer, topBar } from "theme/styles/shell";
import { applyVsCodeColors } from "theme/vscode-colors";
import { reportArchitecture } from "../shared/architecture";
import { reportShellMetrics } from "../shared/editor-metrics";
import { ci } from "./ci";
import { commit } from "./commit";
import { renderGitPanel } from "./git-panel";
import { github } from "./github-control";
import { Icon } from "./icon";
import { previewWindows } from "./preview-windows";
import { push } from "./push";
import { repoLoad } from "./repo-load";
import { reset } from "./reset-popover";
import { runMenu } from "./run-menu";
import { signIn } from "./sign-in";
import "theme/components/page";
import "theme/components/popover";
import "theme/components/button";
import "theme/components/callout";
import "theme/components/checkbox";
import "theme/components/divider";
import "theme/components/input";
import "theme/components/relative-time";
import "theme/chrome"; // Web Awesome (not its native styles), our brand tokens, the system's light/dark mode

/** The top window's features, started in this order once the hub is linked; their controls placed in it. */
const FEATURES: ShellFeature[] = [
	push,
	ci,
	signIn,
	repoLoad,
	runMenu,
	commit,
	reset,
	github,
	previewWindows
];

// The resizable pane's limits (px). The min keeps it usable, the max caps it at a fraction of the viewport so it can't
// swallow the editor.
const PANE = { "asideDefault": 380, "asideMin": 300 };
const paneMax = (): number => Math.min(600, Math.round(window.innerWidth * 0.45));

/** A persisted pane width, clamped later against the live max. Falls back to the default if unset/invalid. */
function loadPaneWidth(key: string, fallback: number): number {
	try {
		const value = Number(localStorage.getItem("shell:" + key));

		return Number.isFinite(value) && value > 0
			? value
			: fallback;
	} catch {
		return fallback;
	}
}

// A collapsed pane isn't hidden — it becomes a slim RAIL (WebAwesome vertical social-share pattern): a pill card
// with a stacked icon-button + tiny caption that reopens the pane. This is the region's width when collapsed.
const RAIL_WIDTH = 68;

interface RailItem {
	"node": Parameters<typeof Icon>[0]["node"];
	"label": string;
	"title": string;
	"onClick": () => void;
}

/** A collapsed pane's rail: a bare vertical stack of pill icon-buttons with captions (no card). Rendered as a
 *  fragment straight into the pane's slot region so the region's other content (the imperatively-mounted git panel)
 *  can stay mounted-but-hidden across collapse. */
function RailContent({ items }: { "items": RailItem[] }) {
	return (
		<>
			{items.map((item) => (
				<span key={item.label} class="wa-stack wa-gap-3xs wa-align-items-center">
					<wa-button appearance="plain" variant="neutral" size="small" pill title={item.title} aria-label={item.title} onClick={item.onClick}><Icon node={item.node} /></wa-button>

					<span class="wa-caption-3xs wa-text-center">{item.label}</span>
				</span>
			))}
		</>
	);
}

/** The shell chrome. Owns the shell hub and, once mounted, links it to the app iframe, mounts the review panel into
 *  the aside, and starts the features. */
function Shell() {
	// The pane starts collapsed (as a rail) so the editor gets the room by default; expand from the rail when needed.
	const [rhsCollapsed, setRhsCollapsed] = useState(true);
	const [asideWidth, setAsideWidth] = useState(() => loadPaneWidth("asideWidth", PANE.asideDefault));
	// What the features are given, once the hub is linked (their controls are placed then).
	const [shell, setShell] = useState<ShellContext | undefined>(undefined);

	const pageRef = useRef<HTMLElement>(null);
	const appFrameRef = useRef<HTMLIFrameElement>(null);
	const gitPanelRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const overlayTitleRef = useRef<HTMLSpanElement>(null);
	const overlayBodyRef = useRef<HTMLDivElement>(null);
	const overlayCloseRef = useRef<HTMLElement>(null);

	// Mount-once wiring: the shell hub linked to the app iframe, the review panel, and the features. A LAYOUT
	// effect, so it runs right after the first render: a plain effect waits for the first paint, which a page opened
	// in a background tab doesn't get (its timers are throttled to about once a second), and everything the editor
	// loads waits on this iframe.
	useLayoutEffect(() => {
		const appFrame = appFrameRef.current;

		if (appFrame === null) {
			return;
		}

		const shellHub = createHub({ "id": "shell" });

		// Load the SAME page into the iframe; that instance sees `window.parent !== window` → main.tsx boots the app.
		performance.mark("shell/app-iframe");
		// (without an instance's name: that says "the top of one", and the app finds it by looking up: shared/instance.ts)
		const appAddress = new URL(location.href);

		appAddress.searchParams.delete("instance");
		appFrame.src = appAddress.href;

		reportArchitecture(shellHub); // this realm's hub + network (GitHub, Code Hike) on $sys.arch
		// …and its logs and spans (the GitHub data plane's, a repository's load, the reset's), on `$sys.log.shell`, and its
		// uncaught errors: debug-mcp and the monitor see the shell as they see every other context.
		relayLoggerToHub(shellHub, "shell");
		tapConsoleAndErrors(shellHub, "shell");
		shellHub.link(windowTransport(appFrame.contentWindow));
		reportShellMetrics(shellHub); // its long frames, on the metrics plane (editor-metrics.ts)

		// The editor (workbench iframe) follows the OS theme too. The shell is the source of truth for the OS
		// preference — it reliably gets prefers-color-scheme changes, whereas the iframe may not — so publish the
		// scheme (initially + on change) and let workbench-entry.tsx set the editor theme from it.
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const publishScheme = (): void => {
			shellHub.publish("theme.colorScheme", { "dark": scheme.matches });
		};

		publishScheme();
		scheme.addEventListener("change", publishScheme);
		// And the shell draws in VS Code's colours, as the editor publishes them (theme/vscode-colors): the top bar, the panels and their popovers read as VS Code's.
		shellHub.subscribe("theme.colors", (colors) => {
			applyVsCodeColors(document.body, colors as VsCodeColors);
		});

		// The RHS review panel — GitHub-Desktop-style changes + commit; the diff opens in the overlay over the editor.
		renderGitPanel(gitPanelRef.current, {
			"el": overlayRef.current,
			"title": overlayTitleRef.current,
			"body": overlayBodyRef.current,
			"close": overlayCloseRef.current
		}, shellHub, (<wa-button appearance="plain" size="small" title="Collapse" aria-label="Collapse changes panel" onClick={() => { setRhsCollapsed(true); }}><Icon node={ChevronRight} /></wa-button>));

		const context: ShellContext = {
			"hub": shellHub,
			"rpc": createRpcClient(shellHub)
		};

		for (const feature of FEATURES) {
			feature.start?.(context);
		}

		setShell(context);
	}, []);

	// Apply the pane's width to wa-page's CSS var (collapsed → the rail's). Clamp against the live max so a narrow viewport
	// can't leave it wider than the editor. Inline `setProperty` wins over the static `.wa-shell` defaults.
	useEffect(() => {
		pageRef.current?.style.setProperty("--aside-width", (rhsCollapsed
			? RAIL_WIDTH
			: Math.min(asideWidth, paneMax())) + "px");
	}, [asideWidth, rhsCollapsed]);

	// Persist the width so it survives reloads (per browser; localStorage may be unavailable in private mode).
	useEffect(() => {
		try {
			localStorage.setItem("shell:asideWidth", String(asideWidth));
		} catch { /* private mode / disabled */ }
	}, [asideWidth]);

	// Drag the pane's inner-edge grip. Pointer capture keeps the drag tracking even over the editor iframe.
	const startResize = (event: PointerEvent): void => {
		event.preventDefault();

		const handle = event.currentTarget as HTMLElement;
		const max = paneMax();

		handle.setPointerCapture(event.pointerId);

		const onMove = (move: PointerEvent): void => {
			setAsideWidth(Math.max(PANE.asideMin, Math.min(max, Math.round(window.innerWidth - move.clientX))));
		};

		const onUp = (up: PointerEvent): void => {
			handle.releasePointerCapture(up.pointerId);
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
		};

		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
	};

	// Keyboard resize (the grip is a focusable separator): arrows nudge by 16px — the pane grows leftward, as it's dragged.
	const onResizeKey = (event: KeyboardEvent): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}

		event.preventDefault();

		const nudge = event.key === "ArrowLeft"
			? 16
			: -16;
		const max = paneMax();

		setAsideWidth((value) => Math.max(PANE.asideMin, Math.min(max, value + nudge)));
	};

	const controls = (place: "start" | "end") => (shell === undefined
		? []
		: FEATURES.flatMap((feature, index) => {
				const { control } = feature;

				return control?.place === place
					? [<control.Control key={index} shell={shell} />]
					: [];
			}));

	const shellClass = [
		"wa-shell",
		rhsCollapsed ? "rhs-collapsed" : ""
	].filter(Boolean).join(" ");

	return (
		<wa-page ref={pageRef} class={shellClass} mobile-breakpoint="0" disable-navigation-toggle>
			<div slot="header" class={"wa-cluster wa-flex-nowrap wa-gap-2xs " + topBar()}>
				<span class="wa-font-weight-semibold wa-color-text-quiet">editor</span>

				{controls("start")}

				<span class={spacer()} />

				{controls("end")}

				<wa-button appearance="plain" size="small" title="Toggle changes panel" aria-label="Toggle changes panel" onClick={() => { setRhsCollapsed((value) => !value); }}><Icon node={PanelRight} /></wa-button>
			</div>

			<div class={mainWrap()}>
				<iframe ref={appFrameRef} class={editorFrame()} title="editor" allow="cross-origin-isolated" />

				<div ref={overlayRef} class={overlay()}>
					<div class={overlayBar() + " wa-cluster wa-flex-nowrap wa-gap-2xs"}>
						<span ref={overlayTitleRef} class={"wa-font-size-xs wa-text-truncate " + overlayTitle()} />

						<wa-button ref={overlayCloseRef} appearance="plain" size="small" title="Close diff" aria-label="Close diff"><Icon node={ChevronRight} /></wa-button>
					</div>

					<div ref={overlayBodyRef} class={overlayBody()} />
				</div>
			</div>

			{/* The aside slot stays mounted across collapse so the imperatively-rendered git panel (mounted once, in
			    the effect above) survives — collapsed just hides it and shows the rail. Its header (with the collapse
			    button, passed in above) is the panel's own. The children are KEYED: unkeyed, a sibling swapping in
			    or out can make preact reuse the git panel's host <div> for another element, stamping that element's
			    class and children onto it — the panel then renders inside it. */}
			<div
				slot="aside"
				class={rhsCollapsed
					? "wa-stack wa-gap-m wa-align-items-center " + railRegion()
					: "wa-stack wa-gap-0 " + sideCol() + " " + asidePane()}
			>
				{rhsCollapsed && (
					<RailContent
						key="rail"
						items={[
							{
								"node": PanelRight,
								"label": "Changes",
								"title": "Expand changes panel",
								"onClick": () => { setRhsCollapsed(false); }
							}
						]}
					/>
				)}

				<div key="git-panel" ref={gitPanelRef} class={sideHost()} hidden={rhsCollapsed} />

				{!rhsCollapsed && (
					<div
						key="resizer"
						class={resizer() + " " + resizerLeft()}
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize changes panel"
						tabIndex={0}
						onPointerDown={startResize}
						onKeyDown={onResizeKey}
					/>
				)}
			</div>

			{shell !== undefined && FEATURES.flatMap((feature, index) => (feature.Overlay === undefined
				? []
				: [<feature.Overlay key={index} shell={shell} />]))}
		</wa-page>
	);
}

/** Build the shell chrome and iframe the app, linked over the hub. */
export function renderShell(): void {
	// Load milestones (with main.tsx's shell/import and the app iframe's own), for load investigations.
	performance.mark("shell/render");
	injectGlobals();
	render(<Shell />, document.body);
}
