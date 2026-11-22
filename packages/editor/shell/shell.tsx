/** @jsxImportSource preact */
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
import { errorReports } from "./error-notice";
import { playground } from "./playground";
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
import "theme/chrome";

const FEATURES: ShellFeature[] = [
	push,
	ci,
	signIn,
	repoLoad,
	playground,
	runMenu,
	commit,
	reset,
	github,
	previewWindows,
	errorReports
];

const PANE = { "asideDefault": 380, "asideMin": 300 };
const paneMax = (): number => Math.min(600, Math.round(window.innerWidth * 0.45));

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

const RAIL_WIDTH = 68;

interface RailItem {
	"node": Parameters<typeof Icon>[0]["node"];
	"label": string;
	"title": string;
	"onClick": () => void;
}

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

function Shell() {
	const [rhsCollapsed, setRhsCollapsed] = useState(true);
	const [asideWidth, setAsideWidth] = useState(() => loadPaneWidth("asideWidth", PANE.asideDefault));
	const [shell, setShell] = useState<ShellContext | undefined>(undefined);

	const pageRef = useRef<HTMLElement>(null);
	const appFrameRef = useRef<HTMLIFrameElement>(null);
	const gitPanelRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const overlayTitleRef = useRef<HTMLSpanElement>(null);
	const overlayBodyRef = useRef<HTMLDivElement>(null);
	const overlayCloseRef = useRef<HTMLElement>(null);

	useLayoutEffect(() => {
		const appFrame = appFrameRef.current;

		if (appFrame === null) {
			return;
		}

		const shellHub = createHub({ "id": "shell" });

		performance.mark("shell/app-iframe");
		const appAddress = new URL(location.href);

		appAddress.searchParams.delete("instance");
		appFrame.src = appAddress.href;

		reportArchitecture(shellHub);
		relayLoggerToHub(shellHub, "shell");
		tapConsoleAndErrors(shellHub, "shell");
		shellHub.link(windowTransport(appFrame.contentWindow));
		reportShellMetrics(shellHub);

		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const publishScheme = (): void => {
			shellHub.publish("theme.colorScheme", { "dark": scheme.matches });
		};

		publishScheme();
		scheme.addEventListener("change", publishScheme);
		shellHub.subscribe("theme.colors", (colors) => {
			applyVsCodeColors(document.body, colors as VsCodeColors);
		});

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

	useEffect(() => {
		pageRef.current?.style.setProperty("--aside-width", (rhsCollapsed
			? RAIL_WIDTH
			: Math.min(asideWidth, paneMax())) + "px");
	}, [asideWidth, rhsCollapsed]);

	useEffect(() => {
		try {
			localStorage.setItem("shell:asideWidth", String(asideWidth));
		} catch { /* private mode / disabled */ }
	}, [asideWidth]);

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

export function renderShell(): void {
	performance.mark("shell/render");
	injectGlobals();
	render(<Shell />, document.body);
}
