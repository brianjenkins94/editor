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
 * this channel — the catalog lives app-side (samples.ts); we send only ids. The RHS review panel (git-panel.tsx, Web Awesome
 * components of its own) is mounted into the `aside` region.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ComponentChildren } from "preact";
import type { SharedWorkspace } from "../shared/playground-link";
import type { LaunchTarget, RunInfo } from "../shared/runs";
import type { RepoBinding } from "./github-auth";
import { createHub, createRpcClient, windowTransport } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
import { ChevronLeft, ChevronRight, FolderOpen, GitBranch, GitCommit, History, LogOut, PanelLeft, PanelRight, Play, Share2 } from "lucide";
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { reportArchitecture } from "../shared/architecture";
import { reportShellMetrics } from "../shared/editor-metrics";
import { parsePlaygroundLink, playgroundLink } from "../shared/playground-link";
import { css, globalCss } from "theme/stitches";
import { iconSvg } from "../shared/theme";
import { envRepo, showRepo, site } from "./address";
import { renderGitPanel } from "./git-panel";
import { forgetPat, getRepoBinding, GITHUB_APP_INSTALL, setRepoBinding } from "./github-auth";
import type { Reporting } from "./reporting";
import type { Session } from "./session";
import { createShellDock } from "./shell-dock";
import { installShellPreview } from "./shell-preview";
import "theme/components/page";
import "theme/components/popover";
import "theme/components/button";
import "theme/components/callout";
import "theme/components/card";
import "theme/components/divider";
import "theme/components/dropdown";
import "theme/components/dropdown-item";
import "theme/components/input";
import "theme/components/relative-time";
import "theme/chrome"; // Web Awesome (not its native styles), our brand tokens, the system's light/dark mode

// The GitHub data plane's logger — spans + records federate to the `$sys.log.>` observability plane (debug-mcp).
// The shell owns the token and the network calls, so this is where load/commit/connect are traced.
const githubLog = logger({ "source": "github" });

function errText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	// What isn't an Error is stringified as it is (a thrown string, if anything else).
	const thrown = error as string | number | boolean | null | undefined;

	return String(thrown);
}

const statusOf = (error: unknown): number | undefined => (typeof (error as { "status"?: unknown }).status === "number" ? (error as { "status": number }).status : undefined);

interface SampleInfo { "id": string; "name": string; "description": string }

// Structural CSS — the little that wa-page doesn't give us: full-viewport height, the editor iframe filling `main`,
// the diff overlay, and the collapse widths. All via theme tokens (stitches objects, not CSS strings).
const injectGlobals = globalCss({
	// `clip`, not `hidden`: the shell page must never scroll, and a hidden overflow still scrolls programmatically — as
	// when VS Code focuses an editor in a dock panel mid-layout and the browser scrolls the page to show it.
	"html, body": { "height": "100%", "margin": 0, "overflow": "clip" },
	"body": { "backgroundColor": "var(--wa-color-surface-default)", "color": "var(--wa-color-text-normal)", "fontFamily": "var(--wa-font-family-body)" },
	// The shell fills the viewport; its menu/aside widths are theme-driven and collapse to 0 via the classes below.
	".wa-shell": { "height": "100vh", "--menu-width": "260px", "--aside-width": "380px" },
	// Collapsed = a slim rail, not hidden (the effect drives the exact value; these are the first-paint fallback).
	".wa-shell.lhs-collapsed": { "--menu-width": "68px" },
	".wa-shell.rhs-collapsed": { "--aside-width": "68px" }
});

// The top bar: branding + icon actions, spread across the header. wa-button (plain) for every control.
const topBar = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-2xs)", "padding": "0 var(--wa-space-s)", "height": "40px", "borderBottom": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" });
const brand = css({ "fontWeight": "var(--wa-font-weight-semibold)", "marginInlineEnd": "var(--wa-space-s)", "color": "var(--wa-color-text-quiet)" });
const spacer = css({ "flex": "1 1 auto" });

// The top bar's popovers (Run's menu is a wa-dropdown; Commit, Share and GitHub are wa-popovers anchored to their
// buttons): Web Awesome positions them in the top layer, over the editor's iframe, and closes them on an outside click
// or Escape. A popover's content is a column this wide, to hold a token or a link.
const popoverBody = css({ "width": "300px", "maxWidth": "80vw" });
const ghTitle = css({ "fontWeight": "var(--wa-font-weight-semibold)", "fontSize": "var(--wa-font-size-s)" });
const ghHint = css({ "fontSize": "var(--wa-font-size-2xs)", "color": "var(--wa-color-text-quiet)", "lineHeight": 1.45 });
const ghLink = css({ "color": "var(--wa-color-brand-fill-loud)", "textDecoration": "none", "whiteSpace": "nowrap", "&:hover": { "textDecoration": "underline" } });
const ghInput = css({ "width": "100%", "&::part(input)": { "fontFamily": "var(--wa-font-family-code)" } });
const ghError = css({ "fontSize": "var(--wa-font-size-2xs)", "color": "var(--wa-color-danger-fill-loud)", "lineHeight": 1.4 });
// An uncaught error's id (shell/reporting.ts), to quote: over everything, bottom right, until dismissed or a minute on.
const errorNotice = css({ "position": "fixed", "insetInlineEnd": "var(--wa-space-m)", "insetBlockEnd": "var(--wa-space-m)", "zIndex": 2147483000, "maxWidth": "360px", "fontSize": "var(--wa-font-size-xs)" });
const ghOk = css({ "fontSize": "var(--wa-font-size-2xs)", "color": "var(--wa-color-success-fill-loud)", "lineHeight": 1.4 });
const ghConnected = css({ "fontSize": "var(--wa-font-size-xs)", "color": "var(--wa-color-text-normal)" });
const ghActions = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-xs)", "marginBlockStart": "var(--wa-space-2xs)" });
const ghSession = css({ "display": "flex", "alignItems": "center", "justifyContent": "space-between", "gap": "var(--wa-space-xs)" });
const ghSessionText = css({ "display": "flex", "flexDirection": "column", "minWidth": 0 });

// The menu/aside regions are full-height flex columns: a fixed header strip, then a scrolling body — so the projects
// list and the git panel each fill their side and scroll internally. `--header-height` is published by wa-page.
const sideCol = css({ "height": "calc(100dvh - var(--header-height, 40px))", "display": "flex", "flexDirection": "column", "minHeight": 0 });
// The panes flanking the editor get a border on the edge that meets it: the LHS project pane on its right, the RHS
// changes pane on its left. `position: relative` anchors the absolute resize grip on that inner edge.
const navPane = css({ "position": "relative", "borderInlineEnd": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" });
const asidePane = css({ "position": "relative", "borderInlineStart": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" });

// A thin drag grip straddling a pane's inner edge (the border meeting the editor) — absolute so it never shifts
// layout, with a wider hit area than the 1px border and a hover/active accent. Pointer-capture drives the drag so
// it keeps tracking even as the cursor passes over the editor iframe.
const resizer = css({
	"position": "absolute",
	"top": 0,
	"bottom": 0,
	"width": "7px",
	"zIndex": 5,
	"cursor": "col-resize",
	"touchAction": "none",
	"&:hover": { "backgroundColor": "var(--wa-color-brand-fill-quiet)" },
	"&:active": { "backgroundColor": "var(--wa-color-brand-fill-loud)" },
	"&:focus-visible": { "outline": "var(--wa-focus-ring)", "outlineOffset": "calc(-1 * var(--wa-focus-ring-width))" }
});
const resizerRight = css({ "insetInlineEnd": "-3px" }); // nav pane: grip on its right edge
const resizerLeft = css({ "insetInlineStart": "-3px" }); // aside pane: grip on its left edge

// Resizable-pane limits (px). Defaults match the former fixed widths; the min keeps each pane usable, the max caps
// at a fraction of the viewport so a pane can't swallow the editor.
const PANE = { "navDefault": 260, "asideDefault": 380, "navMin": 200, "asideMin": 300 };
const paneMax = (): number => Math.min(600, Math.round(window.innerWidth * 0.45));

/** Pick a file to focus after loading a repo: a top-level README, else the first source/markup file, else the first
 *  file — so the load is immediately visible. Paths are repo-relative; the caller has rooted them under /workspace. */
function pickOpenEditors(paths: string[]): string[] {
	const preferred = paths.find((path) => /^readme\.md$/iu.test(path)) ?? paths.find((path) => /\.(?:tsx?|jsx?|html|md)$/iu.test(path)) ?? paths[0];

	return preferred !== undefined ? ["/workspace/" + preferred] : [];
}

/** A persisted pane width, clamped later against the live max. Falls back to the default if unset/invalid. */
function loadPaneWidth(key: string, fallback: number): number {
	try {
		const value = Number(localStorage.getItem("shell:" + key));

		return Number.isFinite(value) && value > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

// A collapsed pane isn't hidden — it becomes a slim RAIL (WebAwesome vertical social-share pattern): a pill card
// with a stacked icon-button + tiny caption that reopens the pane. This is the region's width when collapsed.
const RAIL_WIDTH = 68;
// A bare vertical column of icon-buttons, top-aligned and centered in the rail — no card, no region padding (the
// wa-page menu/aside parts already have none), just the stack.
const railRegion = css({ "height": "calc(100dvh - var(--header-height, 40px))", "display": "flex", "flexDirection": "column", "alignItems": "center", "gap": "var(--wa-space-m)", "paddingBlockStart": "var(--wa-space-2xs)", "overflow": "hidden" });
// Caption hugs its icon (tight) while the gap BETWEEN items (railRegion, above) is larger — so each icon+caption
// reads as one unit.
const railItem = css({ "display": "flex", "flexDirection": "column", "alignItems": "center", "gap": "var(--wa-space-3xs)" });
const railCaption = css({ "fontSize": "var(--wa-font-size-3xs)", "lineHeight": 1.1, "color": "var(--wa-color-text-quiet)", "textAlign": "center", "maxWidth": "100%", "overflowWrap": "anywhere" });
// Keeps an imperatively-mounted region (the git panel) in the DOM but out of view while its pane is collapsed.
const hiddenBox = css({ "display": "none" });
const sideBody = css({ "flex": "1 1 0", "minHeight": 0, "overflowY": "auto" });
const sideHost = css({ "flex": "1 1 0", "minHeight": 0 });

// Navigation (projects) region.
const navHead = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-2xs)", "padding": "var(--wa-space-2xs) var(--wa-space-xs)", "textTransform": "uppercase", "fontSize": "var(--wa-font-size-2xs)", "letterSpacing": "0.06em", "color": "var(--wa-color-text-quiet)", "flex": "0 0 auto" });
const navHeadLabel = css({ "flex": "1 1 auto" });
const picker = css({ "display": "flex", "flexDirection": "column", "gap": "var(--wa-space-2xs)", "padding": "var(--wa-space-xs)" });
const projectCard = css({
	"cursor": "pointer",
	"--spacing": "var(--wa-space-xs)",
	"&::part(body)": { "display": "block" },
	"&:hover::part(body)": { "backgroundColor": "var(--wa-color-neutral-fill-quiet)" },
	"&:focus-visible": { "outline": "var(--wa-focus-ring)", "outlineOffset": "var(--wa-focus-ring-offset)" },
	"&.selected::part(body)": { "backgroundColor": "var(--wa-color-brand-fill-quiet)" },
	"&.selected": { "borderInlineStart": "var(--wa-border-width-m) var(--wa-border-style) var(--wa-color-brand-fill-loud)" }
});
const projectName = css({ "display": "block", "fontWeight": "var(--wa-font-weight-semibold)" });
const projectDesc = css({ "display": "block", "fontSize": "var(--wa-font-size-2xs)", "color": "var(--wa-color-text-quiet)", "marginBlockStart": "var(--wa-space-3xs)", "whiteSpace": "normal" });

// The dock fills the `main` region (the editor iframe is its fixed panel); the diff overlay covers it when a file is opened.
const dockHostCss = css({ "position": "absolute", "inset": 0 });
const mainWrap = css({ "position": "relative", "height": "100%" });
const overlay = css({
	"position": "absolute",
	"inset": 0,
	"zIndex": 20,
	"display": "none",
	"flexDirection": "column",
	"backgroundColor": "var(--wa-color-surface-default)",
	"&.open": { "display": "flex" }
});
const overlayHead = css({ "display": "flex", "alignItems": "center", "gap": "var(--wa-space-2xs)", "height": "34px", "padding": "0 var(--wa-space-2xs) 0 var(--wa-space-s)", "borderBottom": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)", "flex": "0 0 auto" });
const overlayTitle = css({ "flex": "1 1 auto", "fontFamily": "var(--wa-font-family-code)", "fontSize": "var(--wa-font-size-xs)", "whiteSpace": "nowrap", "overflow": "hidden", "textOverflow": "ellipsis" });
const overlayBody = css({ "flex": "1 1 auto", "overflow": "auto", "minHeight": 0 });

/** A lucide icon rendered into a Web Awesome button. */
function Icon({ node }: { "node": Parameters<typeof iconSvg>[0] }) {
	return <span dangerouslySetInnerHTML={{ "__html": iconSvg(node, { "size": 17 }) }} />;
}

/** The projects picker — one Web Awesome button per sample, driven by the hub catalog. `samples` is undefined until
 *  the app answers `project.list`; an empty answer is a real state (no bundled samples), not "still connecting". */
function Picker({ samples, currentId, onOpen }: { "samples"?: SampleInfo[]; "currentId"?: string; "onOpen": (id: string) => void }) {
	if (samples === undefined) {
		return <div class={picker()}>Connecting to editor…</div>;
	}

	if (samples.length === 0) {
		return <div class={picker()}>No bundled projects. Load a GitHub repo from the top bar.</div>;
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

interface RailItem {
	"node": Parameters<typeof iconSvg>[0];
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
				<span key={item.label} class={railItem()}>
					<wa-button appearance="plain" variant="neutral" size="small" pill title={item.title} aria-label={item.title} onClick={item.onClick}><Icon node={item.node} /></wa-button>

					<span class={railCaption()}>{item.label}</span>
				</span>
			))}
		</>
	);
}

/** What a run target is, as its row says: a task, the workspace's own script, or the package whose script it is. */
function targetKind(target: LaunchTarget): string {
	if (target.package === undefined) {
		return "task";
	}

	return target.package === "." ? "script" : target.package;
}

/** The shell chrome. Owns the shell hub and, once mounted, links it to the app iframe, mounts the review panel into
 *  the aside, and installs the (top-frame) preview window. */
function Shell() {
	// Both panes start collapsed (as rails) so the editor gets the room by default; expand from the rail when needed.
	const [lhsCollapsed, setLhsCollapsed] = useState(true);
	const [rhsCollapsed, setRhsCollapsed] = useState(true);
	const [samples, setSamples] = useState<SampleInfo[]>();
	const [currentId, setCurrentId] = useState<string | undefined>(undefined);
	const [navWidth, setNavWidth] = useState(() => loadPaneWidth("navWidth", PANE.navDefault));
	const [asideWidth, setAsideWidth] = useState(() => loadPaneWidth("asideWidth", PANE.asideDefault));
	const [targets, setTargets] = useState<LaunchTarget[]>([]);
	const [runs, setRuns] = useState<RunInfo[]>([]);
	// Signing in (session.ts), optional: `signedInAs` says who (GitHub's login, or the account's email; undefined = signed
	// out); `githubUser` is GitHub's login when the sign-in is GitHub's (fetched live through the API's proxy), what private
	// repos and commits need. The session (oauth4webapi) and the client (fido) are only imported when needed, so they
	// code-split out of the cold-start bundle; so does the account dialog.
	const [signedInAs, setSignedInAs] = useState<string | undefined>(undefined);
	const [githubUser, setGithubUser] = useState<string | undefined>(undefined);
	const [AccountDialog, setAccountDialog] = useState<typeof import("./account-dialog").AccountDialog | undefined>(undefined);
	const [githubOpen, setGithubOpen] = useState(false);
	const [githubBusy, setGithubBusy] = useState(false);
	const [githubError, setGithubError] = useState<string | undefined>(undefined);
	const [signInHere, setSignInHere] = useState(false);
	// The API down for maintenance (its kill switch): no sign-in offered; signed in, the editor carries on as signed out.
	const [apiDown, setApiDown] = useState(false);
	// Where you're signed in (listed when the popover opens, signed in), and the account deletion's confirmation step.
	const [mySessions, setMySessions] = useState<Session[] | undefined>(undefined);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [githubNotice, setGithubNotice] = useState<string | undefined>(undefined);
	const [repoInput, setRepoInput] = useState("");
	const [loadingRepo, setLoadingRepo] = useState(false);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [boundRepo, setBoundRepo] = useState<RepoBinding | undefined>(() => getRepoBinding());
	// Commit-back popover (the top-bar Commit button).
	const [commitOpen, setCommitOpen] = useState(false);
	const [commitMessage, setCommitMessage] = useState("");
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState<string | undefined>(undefined);
	const [commitResult, setCommitResult] = useState<string | undefined>(undefined);
	// Share popover (the top-bar Share button): the workspace as a playground link, copied as it opens.
	const [shareOpen, setShareOpen] = useState(false);
	const [share, setShare] = useState<{ "url"?: string; "skipped"?: string[]; "copied"?: boolean; "error"?: string } | undefined>(undefined);

	const rpcRef = useRef<ReturnType<typeof createRpcClient>>();
	const pageRef = useRef<HTMLElement>(null);
	const dockHostRef = useRef<HTMLDivElement>(null);
	const gitPanelRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const overlayTitleRef = useRef<HTMLSpanElement>(null);
	const overlayBodyRef = useRef<HTMLDivElement>(null);
	const overlayCloseRef = useRef<HTMLElement>(null);
	const hubRef = useRef<Hub>();
	const reportingRef = useRef<Reporting>();
	const [errorId, setErrorId] = useState<string | undefined>(undefined);
	// Settles once the app answers (below): a repo opened from the address (`env/<owner>/<repo>`) is published only then.
	const appReadyRef = useRef<{ "promise": Promise<void>; "resolve": () => void }>();

	appReadyRef.current ??= (() => {
		let resolve: () => void;
		const promise = new Promise<void>((done) => {
			resolve = done;
		});

		return { "promise": promise, "resolve": () => { resolve(); } };
	})();

	// Mount-once wiring: the shell hub linked to the app iframe, the review panel, and the preview window. A LAYOUT
	// effect, so it runs right after the first render: a plain effect waits for the first paint, which a page opened
	// in a background tab doesn't get (its timers are throttled to about once a second), and everything the editor
	// loads waits on this iframe.
	useLayoutEffect(() => {
		const dockHost = dockHostRef.current;

		if (dockHost === null) {
			return;
		}

		const shellHub = createHub({ "id": "shell" });
		// The main region is a dock: the editor iframe is its fixed panel, VS Code's new windows dock around it.
		const dock = createShellDock(dockHost, shellHub);
		const appFrame = dock.editorFrame;

		// A TypeScript Playground link (playground-link.ts) is a one-shot import: it's opened once the app answers below,
		// and dropped from the address bar now, so a reload keeps the edits made since instead of importing it again.
		const playground = parsePlaygroundLink(location.hash, location.search);

		if (playground !== undefined) {
			history.replaceState(history.state, "", location.pathname + location.search);
		}

		// Load the SAME page into the iframe; that instance sees `window.parent !== window` → main.tsx boots the app.
		performance.mark("shell/app-iframe");
		appFrame.src = location.href;

		const architecture = reportArchitecture(shellHub); // this realm's hub + network (GitHub, Code Hike) on $sys.arch

		hubRef.current = shellHub;
		// The session timeline's events and every realm's uncaught errors, to the API (shell/reporting.ts).
		void import("./reporting").then(({ startReporting }) => {
			reportingRef.current = startReporting(shellHub, setErrorId);
		});
		shellHub.link(windowTransport(appFrame.contentWindow));

		// The preview windows live in the top frame so they can roam beyond the editor — every server's (a dev server's, a
		// program's own), all managed here. See shell-preview.ts.
		installShellPreview(shellHub, architecture, dock.window);
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

		// The RHS review panel — GitHub-Desktop-style changes + commit; the diff opens in the overlay over the editor.
		renderGitPanel(gitPanelRef.current, {
			"el": overlayRef.current,
			"title": overlayTitleRef.current,
			"body": overlayBodyRef.current,
			"close": overlayCloseRef.current
		}, shellHub, (<wa-button appearance="plain" size="small" title="Collapse" aria-label="Collapse changes panel" onClick={() => { setRhsCollapsed(true); }}><Icon node={ChevronRight} /></wa-button>));

		const rpc = createRpcClient(shellHub);

		rpcRef.current = rpc; // reused by the run picker

		// Pull the catalog once the app iframe's serve interest arrives (asked before it, the call only times out); the
		// retry is a backstop.
		void (async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				try {
					const list = await rpc.request("project.list", undefined, { "timeoutMs": 2000, "waitForResponderMs": 10_000 }) as SampleInfo[];

					if (Array.isArray(list)) {
						setSamples(list);
						appReadyRef.current?.resolve();

						// The app is listening now. A playground project replaces the workspace like a repo load, and isn't
						// any repo's, so a commit has nowhere to push until one is opened.
						if (playground !== undefined) {
							shellHub.publish("project.openFiles", playground);
							setRepoBinding(undefined);
							setBoundRepo(undefined);
							showRepo(undefined);
						}

						return;
					}
				} catch { /* app not linked yet — retry */ }

				await new Promise((resolve) => {
					setTimeout(resolve, 500);
				});
			}
		})();
	}, []);

	// The error notice goes after a minute (dismissed sooner, or replaced by the next).
	useEffect(() => {
		if (errorId === undefined) {
			return;
		}

		const timer = setTimeout(() => {
			setErrorId(undefined);
		}, 60_000);

		return () => {
			clearTimeout(timer);
		};
	}, [errorId]);

	// Apply the pane widths to wa-page's CSS vars (collapsed → 0). Clamp against the live max so a narrow viewport
	// can't leave a pane wider than the editor. Inline `setProperty` wins over the static `.wa-shell` defaults.
	useEffect(() => {
		const page = pageRef.current;

		if (page === null) {
			return;
		}

		const max = paneMax();

		page.style.setProperty("--menu-width", (lhsCollapsed ? RAIL_WIDTH : Math.min(navWidth, max)) + "px");
		page.style.setProperty("--aside-width", (rhsCollapsed ? RAIL_WIDTH : Math.min(asideWidth, max)) + "px");
	}, [navWidth, asideWidth, lhsCollapsed, rhsCollapsed]);

	// Persist widths so they survive reloads (per browser; localStorage may be unavailable in private mode).
	useEffect(() => {
		try {
			localStorage.setItem("shell:navWidth", String(navWidth));
			localStorage.setItem("shell:asideWidth", String(asideWidth));
		} catch { /* private mode / disabled */ }
	}, [navWidth, asideWidth]);

	// Drag a pane's inner-edge grip. Pointer capture keeps the drag tracking even over the editor iframe.
	const startResize = (side: "nav" | "aside") => (event: PointerEvent): void => {
		event.preventDefault();

		const handle = event.currentTarget as HTMLElement;
		const min = side === "nav" ? PANE.navMin : PANE.asideMin;
		const max = paneMax();

		handle.setPointerCapture(event.pointerId);

		const onMove = (move: PointerEvent): void => {
			const raw = side === "nav" ? move.clientX : window.innerWidth - move.clientX;
			const width = Math.max(min, Math.min(max, Math.round(raw)));

			if (side === "nav") {
				setNavWidth(width);
			} else {
				setAsideWidth(width);
			}
		};

		const onUp = (up: PointerEvent): void => {
			handle.releasePointerCapture(up.pointerId);
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
		};

		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
	};

	// Keyboard resize (the grip is a focusable separator): arrows nudge by 16px — nav grows rightward, aside grows
	// leftward, mirroring the drag direction.
	const onResizeKey = (side: "nav" | "aside") => (event: KeyboardEvent): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}

		event.preventDefault();

		const grow = event.key === "ArrowRight" ? side === "nav" : side !== "nav";
		const min = side === "nav" ? PANE.navMin : PANE.asideMin;
		const max = paneMax();
		const clamp = (value: number): number => Math.max(min, Math.min(max, value + (grow ? 16 : -16)));

		if (side === "nav") {
			setNavWidth(clamp);
		} else {
			setAsideWidth(clamp);
		}
	};

	// The run picker: as its menu opens, ask what there is to run — VS Code's tasks, through the pod (`tasks.list`: the
	// workspace's package.json scripts and its own tasks). Picking one runs it as a task (`tasks.run`).
	const loadRunTargets = (): void => {
		void (async () => {
			try {
				const result = await rpcRef.current?.request("tasks.list", undefined, { "timeoutMs": 4000 });

				setTargets(Array.isArray(result) ? result as LaunchTarget[] : []);
			} catch {
				setTargets([]);
			}
		})();

		// What's already running, so a running service is offered as itself rather than as a second copy.
		void rpcRef.current?.request("runs.list", undefined, { "timeoutMs": 4000 }).then((list) => {
			setRuns(Array.isArray(list) ? list as RunInfo[] : []);
		}, () => {
			setRuns([]);
		});
	};

	// A target's run, if it's running now (the registry titles a run as it was typed: `npm run dev`, in its directory).
	const runOf = (target: LaunchTarget): RunInfo | undefined => runs.find((run) => run.state === "running" && run.title === target.command && run.cwd === target.cwd);

	// A running service is already there: show its preview rather than start a second copy (which `vite` refuses). Any
	// other is the pod's to run — or, running, to show its terminal; one that can't start says why in the workbench.
	const runTarget = (target: LaunchTarget): void => {
		const running = runOf(target);

		if (running?.port !== undefined) {
			hubRef.current?.publish("preview.open", { "port": running.port });
		} else {
			void rpcRef.current?.request("tasks.run", { "id": target.id }, { "timeoutMs": 10000 }).catch(() => undefined);
		}
	};

	// Run (RUNNING.md): the file in the editor, as every way in runs it — stopping at breakpoints, its process.argv from
	// the file's stub. It answers at its first stop: nobody waits on it here, and a run that can't start says why in the
	// workbench (the pod shows it).
	const runThisFile = (): void => {
		void rpcRef.current?.request("debug.start", {}, { "timeoutMs": 24 * 60 * 60_000 }).catch(() => undefined);
	};

	// On load: finish a sign-in this page is the end of, and if signed in, show who as (GitHub's login, fetched live through
	// the API's proxy: the API keeps no login; or the account's email). The retired PAT is deleted wherever one was kept.
	useEffect(() => {
		let cancelled = false;
		const signedOut = (): void => {
			setSignedInAs(undefined);
			setGithubUser(undefined);
		};

		forgetPat();
		window.addEventListener("shell:signedOut", signedOut);

		void (async () => {
			const session = await import("./session");
			const span = githubLog.span("github.session");

			try {
				if (await session.completeSignIn()) {
					span.info("signed in");
				}
			} catch (error) {
				setGithubError(error instanceof Error && /access_denied/u.test(error.message) ? "Sign-in was cancelled." : "Sign-in didn't complete. Try again.");
				setGithubOpen(true);
				span.error("sign-in failed", { "error": errText(error) });
			}

			setSignInHere(session.canSignIn());

			// Back from GitHub, connecting it to the account, or from our passkey page, adding one (packages/account finishes
			// either): its dialog, open again.
			if (session.isSignedIn() && /[?&](?:link|link_error|passkey)=/u.test(location.search)) {
				const { "AccountDialog": dialog } = await import("./account-dialog");

				setAccountDialog(() => dialog);
			}

			// An `env/<owner>/<repo>` address opens that repo, once the app listens — after the sign-in above, so a private
			// one is read signed in. The workspace already being that repo's (a reload) keeps it, and the edits made in it. The
			// GitHub popover opens over the load, to show it going and say what went wrong (it closes on success).
			const wanted = envRepo();
			const bound = getRepoBinding();

			if (wanted !== undefined && `${bound?.owner}/${bound?.repo}`.toLowerCase() !== `${wanted.owner}/${wanted.repo}`.toLowerCase()) {
				void appReadyRef.current?.promise.then(async () => {
					setGithubOpen(true);
					await loadRepo(`${wanted.owner}/${wanted.repo}`);
				});
			}

			try {
				if (session.isSignedIn() && await session.apiDown()) {
					if (!cancelled) {
						setApiDown(true);
					}
				} else if (session.isSignedIn()) {
					const me = await session.account();

					if (me.githubId === null) {
						if (!cancelled) {
							setSignedInAs(me.email?.address ?? "your account");
						}
					} else {
						// Signed in either way; GitHub's login only when it can be read (not while the API's GitHub proxy is
						// paused: packages/api OPERATIONS.md O8, when GitHub is reached directly, public repos only).
						if (!cancelled) {
							setSignedInAs("your GitHub account");
						}

						const { connectGitHub } = await import("./github");
						const { login } = await (await connectGitHub()).viewer();

						if (!cancelled) {
							setSignedInAs(login);
							setGithubUser(login);
						}
					}
				}
			} catch (error) {
				span.warn("couldn't read who's signed in", { "error": errText(error), "status": statusOf(error) });
			} finally {
				span.end();
			}
		})();

		return () => {
			cancelled = true;
			window.removeEventListener("shell:signedOut", signedOut);
		};
	}, []);

	// Sign in: a full-page round trip through the API's sign-in page (session.ts); this page loads again at the end of it.
	const signInGithub = async (): Promise<void> => {
		setGithubBusy(true);
		setGithubError(undefined);

		try {
			await (await import("./session")).signIn();
		} catch (error) {
			setGithubBusy(false);
			setGithubError("Couldn't start signing in.");
			githubLog.error("sign-in didn't start", { "error": errText(error) });
		}
	};

	// Before offering a sign-in: whether the API is down for maintenance, asked when the popover opens signed out.
	useEffect(() => {
		if (!githubOpen || signedInAs !== undefined || !signInHere) {
			return;
		}

		void import("./session").then(async (session) => session.apiDown()).then(setApiDown);
	}, [githubOpen, signedInAs, signInHere]);

	// Where you're signed in: listed each time the popover opens, signed in.
	useEffect(() => {
		if (!githubOpen || signedInAs === undefined) {
			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				const list = await (await import("./session")).sessions();

				if (!cancelled) {
					setMySessions(list);
				}
			} catch (error) {
				githubLog.warn("couldn't list sessions", { "error": errText(error) });
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [githubOpen, signedInAs]);

	// A session's way out, an account's way out: each ends here signed out, with what happened said.
	const accountAction = async (run: (session: typeof import("./session")) => Promise<string | undefined>, failure: string): Promise<void> => {
		setGithubBusy(true);
		setGithubError(undefined);
		setGithubNotice(undefined);

		try {
			const notice = await run(await import("./session"));

			setGithubNotice(notice);
		} catch (error) {
			setGithubError(failure);
			githubLog.error(failure, { "error": errText(error) });
		} finally {
			setConfirmingDelete(false);
			setGithubBusy(false);
		}
	};

	const endOtherSession = async (id: string): Promise<void> => accountAction(async (session) => {
		await session.endSession(id);
		setMySessions(await session.sessions());

		return undefined;
	}, "Couldn't end that session.");

	const signOutEverywhere = async (): Promise<void> => accountAction(async (session) => {
		await session.signOutEverywhere();
		setSignedInAs(undefined);
		setGithubUser(undefined);
		setMySessions(undefined);

		return "Signed out everywhere.";
	}, "Couldn't sign out everywhere.");

	const deleteAccount = async (): Promise<void> => accountAction(async (session) => {
		const { githubAuthorizationRevoked } = await session.deleteAccount();
		const github = githubUser !== undefined;

		setSignedInAs(undefined);
		setGithubUser(undefined);
		setMySessions(undefined);

		if (!github) {
			return "Your account is deleted. Sign in within 30 days to bring it back; after that it's gone for good.";
		}

		return githubAuthorizationRevoked ? "Your account is deleted, and the editor's GitHub App no longer has access. Sign in within 30 days to bring it back; after that it's gone for good." : "Your account is deleted. GitHub didn't confirm the app's access ended: remove it under GitHub's Settings → Applications.";
	}, "Couldn't delete the account.");

	// Sign out: the session ends at the API (and GitHub's token with it), and this browser forgets its key.
	const signOutGithub = async (): Promise<void> => {
		setGithubBusy(true);

		try {
			await (await import("./session")).signOut();
		} finally {
			setSignedInAs(undefined);
			setGithubUser(undefined);
			setGithubError(undefined);
			setGithubOpen(false);
			setGithubBusy(false);
		}
	};

	// Load a GitHub repo into the workspace: the SHELL fetches the files (token stays here) and publishes them to the
	// app over the hub, which writes them into zen-fs. Repo paths are rooted under /workspace. github.ts is lazy so
	// fido loads only when a repo is actually fetched.
	const loadRepo = async (input = repoInput): Promise<void> => {
		const match = /^([^\s/]+)\/([^\s/]+)$/u.exec(input.trim());

		if (match === null) {
			setLoadError("Use the form owner/repo");

			return;
		}

		setLoadingRepo(true);
		setLoadError(undefined);

		const span = githubLog.span("github.loadRepo", { "repo": input.trim() });

		try {
			const [, owner, repo] = match;
			// Through the proxy by the session itself, not `githubUser` (fetched after it): a load from the address runs before
			// that. Signed in by email or a password, it's as signed out: GitHub straight, public repos only.
			const signedIn = await (await import("./session")).viaProxy();
			const { connectGitHub } = await import("./github");
			const gh = await connectGitHub();
			const meta = await gh.getRepo(owner, repo);

			if (meta === undefined) {
				setLoadError(signedIn ? "Repo not found, or not one you've given the editor access to." : "Repo not found. A private one needs you signed in with GitHub.");
				span.error("repo not found or not visible");

				return;
			}

			// Clone it — one shallow pack, through the API's proxy when signed in (git-clone.ts) — rather than read it blob by
			// blob through the API, which fido's limiter holds to 100 requests a minute. The API is the fallback.
			let files: { "path": string; "bytes": Uint8Array }[];

			try {
				const { cloneRepo } = await import("./git-clone");

				({ files } = await cloneRepo(owner, repo, signedIn));
				span.info("cloned", { "files": files.length });
			} catch (error) {
				span.warn("clone failed — reading through the API", { "error": errText(error) });
				files = await gh.readRepo(owner, repo);
			}

			if (files.length === 0) {
				setLoadError("That repo has no files");
				span.error("repo has no files", { "branch": meta.default_branch });

				return;
			}

			const projectFiles = files.map((file) => ({ "path": "/workspace/" + file.path, "bytes": file.bytes }));

			// A clone's files include its `.git` (git-clone.ts): the workspace becomes the repo, history and all. Editors open
			// from the working tree only.
			hubRef.current?.publish("project.openFiles", { "files": projectFiles, "openEditors": pickOpenEditors(files.map((file) => file.path).filter((path) => !path.startsWith(".git/"))) });

			// Remember where this workspace came from so a commit knows where to push.
			const binding = { "owner": owner, "repo": repo, "branch": meta.default_branch };

			setRepoBinding(binding);
			setBoundRepo(binding);
			showRepo(binding);
			reportingRef.current?.event({ "name": "repo.loaded", "detail": `${owner}/${repo}` });
			setGithubOpen(false);
			setRepoInput("");
			span.info("loaded", { "branch": meta.default_branch, "files": files.length, "bytes": files.reduce((total, file) => total + file.bytes.length, 0) });
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : "Could not load the repo");
			span.error("load failed", { "error": errText(error), "status": statusOf(error) });
		} finally {
			span.end();
			setLoadingRepo(false);
		}
	};

	// Share the workspace as a Playground v2 link (playground-link.ts) on the site's root (not a repo's address): ask the
	// app for the files and the editor in front, encode them, and copy the link. It opens here, or in the TypeScript Playground.
	const copyShare = async (url: string): Promise<boolean> => navigator.clipboard.writeText(url).then(() => true, () => false);
	const openShare = async (): Promise<void> => {
		setShareOpen(true);
		setShare(undefined);

		try {
			const workspace = await rpcRef.current?.request("workspace.files", undefined, { "timeoutMs": 20000 }) as SharedWorkspace;
			const { skipped, url } = playgroundLink(site(), workspace);

			setShare({ "url": url, "skipped": skipped, "copied": await copyShare(url) });
		} catch (error) {
			setShare({ "error": errText(error) });
		}
	};

	// Commit the current workspace back to the bound repo: ask the app for the files (the pane holds the FS), convert
	// to the Git Data write shape (repo-relative paths; text inline, binary as base64 blobs), and push.
	const commit = async (): Promise<void> => {
		const binding = boundRepo;

		if (binding === undefined) {
			setCommitError("Load a repo first");

			return;
		}

		const message = commitMessage.trim();

		if (message === "") {
			setCommitError("Enter a commit message");

			return;
		}

		setCommitting(true);
		setCommitError(undefined);
		setCommitResult(undefined);

		const span = githubLog.span("github.commit", { "repo": binding.owner + "/" + binding.repo, "branch": binding.branch });

		try {
			const { files } = await rpcRef.current?.request("workspace.files", undefined, { "timeoutMs": 20000 }) as SharedWorkspace;
			const prefix = "/workspace/";
			const { bytesToBase64, connectGitHub } = await import("./github");
			const writes = files.map((file) => {
				const path = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;

				// A NUL byte means binary (git's own heuristic) → upload as a base64 blob; otherwise inline as text.
				return file.bytes.includes(0)
					? { "path": path, "base64": bytesToBase64(file.bytes) }
					: { "path": path, "content": new TextDecoder().decode(file.bytes) };
			});

			const sha = await (await connectGitHub()).commitFiles(binding.owner, binding.repo, { "branch": binding.branch, "message": message, "files": writes });

			setCommitResult(sha.slice(0, 7));
			setCommitMessage("");
			span.info("committed", { "files": writes.length, "bytes": files.reduce((total, file) => total + file.bytes.length, 0), "sha": sha.slice(0, 7) });
		} catch (error) {
			setCommitError(error instanceof Error ? error.message : "Commit failed");
			span.error("commit failed", { "error": errText(error), "status": statusOf(error) });
		} finally {
			span.end();
			setCommitting(false);
		}
	};

	const openProject = (id: string): void => {
		setCurrentId(id);
		setLhsCollapsed(true); // making a selection collapses the projects pane back to its rail
		hubRef.current?.publish("project.open", { "id": id });
		showRepo(undefined);
	};

	// The Commit popover's body: what it needs first, until it has it — then the repo it pushes to, and the message.
	const commitBody = (): ComponentChildren => {
		if (githubUser === undefined) {
			return <span class={ghHint()}>Sign in with GitHub first.</span>;
		}

		if (boundRepo === undefined) {
			return <span class={ghHint()}>Load a repo first — commits push back to the repo the workspace came from.</span>;
		}

		return (
			<>
				<span class={ghHint()}>
					To
					{" "}

					<strong>
						{boundRepo.owner}
						/

						{boundRepo.repo}
					</strong>

					{" "}
					on

					{" "}

					<strong>{boundRepo.branch}</strong>
				</span>

				<wa-input
					class={ghInput()}
					size="small"
					placeholder="Commit message"
					value={commitMessage}
					aria-label="Commit message"
					onInput={(event: Event) => { setCommitMessage((event.currentTarget as HTMLInputElement).value); }}
					onKeyDown={(event: KeyboardEvent) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void commit();
						}
					}}
				/>

				{commitError !== undefined && <span class={ghError()}>{commitError}</span>}

				{commitResult !== undefined && (
					<span class={ghOk()}>
						{`Committed ${commitResult}`}
					</span>
				)}

				<div class={ghActions()}>
					<wa-button variant="brand" size="small" disabled={committing || commitMessage.trim() === ""} onClick={() => { void commit(); }}>{committing ? "Committing…" : "Commit"}</wa-button>
				</div>
			</>
		);
	};

	// The Share popover's body: the link being made, why it couldn't be — or the link, its size, and what it left out.
	const shareBody = (): ComponentChildren => {
		if (share === undefined) {
			return <span class={ghHint()}>Making a link…</span>;
		}

		if (share.error !== undefined) {
			return <span class={ghError()}>{share.error}</span>;
		}

		return (
			<>
				<span class={share.copied === true ? ghOk() : ghHint()}>
					{share.copied === true ? "Link copied." : "Copy this link."}

					{" "}
					It opens this project here, or in the TypeScript Playground.
				</span>

				<wa-input class={ghInput()} size="small" readonly value={share.url} aria-label="Share link" />

				<span class={ghHint()}>
					{(share.url.length / 1024).toFixed(1)}

					{" "}
					KB

					{share.url.length > 8192 && " — some apps cut links this long"}

					{share.skipped.length > 0 && ` · ${share.skipped.length} binary ${share.skipped.length === 1 ? "file" : "files"} left out`}
				</span>

				<div class={ghActions()}>
					<wa-button
						size="small"
						appearance="outlined"
						onClick={() => {
							void copyShare(share.url).then((copied) => {
								setShare({ ...share, "copied": copied });
							});
						}}
					>
						Copy
					</wa-button>
				</div>
			</>
		);
	};

	// Loading a repo, signed in or out: signed out, only a public one.
	const loadSection = (): ComponentChildren => (
		<>
			<span class={ghTitle()}>{githubUser === undefined ? "Load a public repo" : "Load a repo"}</span>

			<span class={ghHint()}>Its files open in the workspace.</span>

			<wa-input
				class={ghInput()}
				size="small"
				placeholder="owner/repo"
				value={repoInput}
				autocapitalize="off"
				autocorrect="off"
				spellcheck={false}
				aria-label="Repository to load"
				onInput={(event: Event) => { setRepoInput((event.currentTarget as HTMLInputElement).value); }}
				onKeyDown={(event: KeyboardEvent) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void loadRepo();
					}
				}}
			/>

			{loadError !== undefined && <span class={ghError()}>{loadError}</span>}

			<div class={ghActions()}>
				<wa-button variant="brand" size="small" disabled={loadingRepo || repoInput.trim() === ""} onClick={() => { void loadRepo(); }}>{loadingRepo ? "Loading…" : "Load"}</wa-button>
			</div>
		</>
	);

	// Your account, in a dialog (account-dialog.tsx, loaded when first opened).
	const openAccount = async (): Promise<void> => {
		const { "AccountDialog": dialog } = await import("./account-dialog");

		setAccountDialog(() => dialog);
	};

	// The GitHub popover's body: who's signed in (and signing out), or signing in, which is optional; then a repo to load.
	const githubBody = (): ComponentChildren => (
		<>
			<span class={ghTitle()}>GitHub</span>

			{signedInAs !== undefined
				? (
					<>
						<span class={ghConnected()}>
							Signed in as
							{" "}

							<strong>{signedInAs}</strong>
						</span>

						{githubUser !== undefined
							? (
								<span class={ghHint()}>
									A private repo needs the editor's GitHub App on it.
									{" "}

									<a class={ghLink()} href={GITHUB_APP_INSTALL} target="_blank" rel="noreferrer noopener">Choose repositories →</a>
								</span>
							)
							: <span class={ghHint()}>Public repos load as signed out. Private repos and commits need a sign-in with GitHub.</span>}

						<div class={ghActions()}>
							<wa-button appearance="outlined" size="small" onClick={() => { void openAccount(); }}>Your account…</wa-button>
						</div>

						<wa-divider />

						<span class={ghTitle()}>Where you're signed in</span>

						{mySessions === undefined
							? <span class={ghHint()}>Loading…</span>
							: mySessions.map((session) => (
								<div class={ghSession()} key={session.id}>
									<span class={ghSessionText()}>
										<span class={ghConnected()}>
											{session.label ?? "A browser"}
											{session.current ? " · this browser" : ""}
										</span>

										<span class={ghHint()}>
											last used
											{" "}

											<wa-relative-time date={new Date(session.lastUsedAt).toISOString()} />
										</span>
									</span>

									{!session.current && <wa-button appearance="plain" size="small" disabled={githubBusy} onClick={() => { void endOtherSession(session.id); }}>Sign out</wa-button>}
								</div>
							))}

						{githubError !== undefined && <span class={ghError()}>{githubError}</span>}

						<div class={ghActions()}>
							<wa-button appearance="outlined" size="small" disabled={githubBusy} onClick={() => { void signOutGithub(); }}>
								<Icon node={LogOut} />

								{" "}
								Sign out
							</wa-button>

							<wa-button appearance="plain" size="small" disabled={githubBusy} onClick={() => { void signOutEverywhere(); }}>Sign out everywhere</wa-button>
						</div>

						{confirmingDelete
							? (
								<>
									<span class={ghError()}>{githubUser !== undefined ? "Deleting your account ends every session at once and takes away the editor's GitHub App's access. It's kept 30 days, when signing in again brings it back; after that nothing we keep points at you. Your repositories on GitHub aren't touched." : "Deleting your account ends every session at once. It's kept 30 days, when signing in again brings it back; after that nothing we keep points at you."}</span>

									<div class={ghActions()}>
										<wa-button variant="danger" size="small" disabled={githubBusy} onClick={() => { void deleteAccount(); }}>Delete my account</wa-button>
										<wa-button appearance="plain" size="small" disabled={githubBusy} onClick={() => { setConfirmingDelete(false); }}>Cancel</wa-button>
									</div>
								</>
							)
							: <wa-button appearance="plain" variant="danger" size="small" disabled={githubBusy} onClick={() => { setConfirmingDelete(true); }}>Delete account…</wa-button>}
					</>
				)
				: signInHere && apiDown
					? <span class={ghHint()}>Signing in is down for maintenance. Everything else works as signed out, and public repos load.</span>
					: signInHere
					? (
						<>
							<span class={ghHint()}>Optional: everything here works without an account. Sign in with GitHub for private repos and commits (GitHub's token stays on the editor's server: this browser never holds it), or with your email.</span>

							{githubNotice !== undefined && <span class={ghOk()}>{githubNotice}</span>}

							{githubError !== undefined && <span class={ghError()}>{githubError}</span>}

							<div class={ghActions()}>
								<wa-button variant="brand" size="small" disabled={githubBusy} onClick={() => { void signInGithub(); }}>{githubBusy ? "Signing in…" : "Sign in"}</wa-button>
							</div>
						</>
					)
					: <span class={ghHint()}>Signing in isn't available on this copy of the editor.</span>}

			<wa-divider />

			{loadSection()}
		</>
	);

	const shellClass = ["wa-shell", lhsCollapsed ? "lhs-collapsed" : "", rhsCollapsed ? "rhs-collapsed" : ""].filter(Boolean).join(" ");

	return (
		<wa-page ref={pageRef} class={shellClass} mobile-breakpoint="0" disable-navigation-toggle>
			<div slot="header" class={topBar()}>
				<span class={brand()}>editor</span>

				<wa-button appearance="plain" size="small" title="Toggle project panel" aria-label="Toggle project panel" onClick={() => { setLhsCollapsed((value) => !value); }}><Icon node={PanelLeft} /></wa-button>

				<wa-button appearance="plain" size="small" title="Open project" aria-label="Open project"><Icon node={FolderOpen} /></wa-button>

				<wa-dropdown
					size="small"
					placement="bottom-start"
					onwa-show={(event: Event) => {
						if (event.target === event.currentTarget) {
							loadRunTargets();
						}
					}}
					onwa-select={(event: CustomEvent<{ "item": HTMLElement & { "value": string } }>) => {
						const { value } = event.detail.item;
						const target = targets.find((each) => each.id === value);

						if (target === undefined) {
							runThisFile();
						} else {
							runTarget(target);
						}
					}}
				>
					<wa-button slot="trigger" appearance="plain" size="small" title="Run" aria-label="Run"><Icon node={Play} /></wa-button>

					<wa-dropdown-item value="" title="Run the file in the editor">The file in the editor</wa-dropdown-item>

					{targets.length === 0 ? (
						<wa-dropdown-item disabled>No package.json scripts or tasks</wa-dropdown-item>
					) : (["service", "task"] as const).map((lifecycle) => {
						const group = targets.filter((target) => target.lifecycle === lifecycle);

						return group.length === 0 ? null : [
							<h3 key={lifecycle}>{lifecycle === "service" ? "Services" : "Tasks"}</h3>,
							...group.map((target) => {
								const running = runOf(target);
								const port = running?.port === undefined ? "" : ` · :${running.port}`;
								const state = running === undefined ? "" : `running${port} · `;

								return (
									<wa-dropdown-item key={target.id} value={target.id} title={`${target.command} — in ${target.cwd}`}>
										{target.name}

										<span slot="details">{state + targetKind(target)}</span>
									</wa-dropdown-item>
								);
							})
						];
					})}
				</wa-dropdown>

				<wa-button
					id="shell-commit"
					appearance="plain"
					size="small"
					title={boundRepo !== undefined ? "Commit to " + boundRepo.owner + "/" + boundRepo.repo : "Commit"}
					aria-label="Commit"
				>
					<Icon node={GitCommit} />
				</wa-button>

				<wa-popover
					for="shell-commit"
					placement="bottom-start"
					open={commitOpen}
					onwa-show={(event: Event) => {
						if (event.target === event.currentTarget) {
							setCommitError(undefined);
							setCommitResult(undefined);
							setCommitOpen(true);
						}
					}}
					onwa-hide={(event: Event) => {
						if (event.target === event.currentTarget) {
							setCommitOpen(false);
						}
					}}
				>
					<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Commit to GitHub">
						<span class={ghTitle()}>Commit</span>

						{commitBody()}
					</div>
				</wa-popover>

				<wa-button id="shell-share" appearance="plain" size="small" title="Share as a link" aria-label="Share"><Icon node={Share2} /></wa-button>

				<wa-popover
					for="shell-share"
					placement="bottom-start"
					open={shareOpen}
					onwa-show={(event: Event) => {
						if (event.target === event.currentTarget) {
							void openShare();
						}
					}}
					onwa-hide={(event: Event) => {
						if (event.target === event.currentTarget) {
							setShareOpen(false);
						}
					}}
				>
					<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Share">
						<span class={ghTitle()}>Share</span>

						{shareBody()}
					</div>
				</wa-popover>

				<span class={spacer()} />

				<wa-button id="shell-github" appearance="plain" size="small" title={githubUser !== undefined ? "GitHub · " + githubUser : "GitHub"} aria-label="GitHub"><Icon node={GitBranch} /></wa-button>

				<wa-popover
					for="shell-github"
					placement="bottom-end"
					open={githubOpen}
					onwa-show={(event: Event) => {
						if (event.target === event.currentTarget) {
							setGithubOpen(true);
						}
					}}
					onwa-hide={(event: Event) => {
						if (event.target === event.currentTarget) {
							setGithubOpen(false);
						}
					}}
				>
					<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="GitHub connection">
						{githubBody()}
					</div>
				</wa-popover>

				<wa-button appearance="plain" size="small" title="History" aria-label="History"><Icon node={History} /></wa-button>

				<wa-button appearance="plain" size="small" title="Toggle history panel" aria-label="Toggle history panel" onClick={() => { setRhsCollapsed((value) => !value); }}><Icon node={PanelRight} /></wa-button>
			</div>

			<div slot="navigation" class={lhsCollapsed ? railRegion() : sideCol() + " " + navPane()}>
				{lhsCollapsed ? (
					<RailContent items={[
						{ "node": PanelLeft, "label": "Projects", "title": "Expand project panel", "onClick": () => { setLhsCollapsed(false); } },
						// placeholders to preview the stacked look — settle final contents next
						{ "node": FolderOpen, "label": "Open", "title": "Open project", "onClick": () => undefined },
						{ "node": Play, "label": "Run", "title": "Run the file in the editor", "onClick": runThisFile }
					]}
					/>
				) : (
					<>
						<div class={navHead()}>
							<span class={navHeadLabel()}>Projects</span>

							<wa-button appearance="plain" size="small" title="Collapse" aria-label="Collapse project panel" onClick={() => { setLhsCollapsed(true); }}><Icon node={ChevronLeft} /></wa-button>
						</div>

						<div class={sideBody()}>
							<Picker samples={samples} currentId={currentId} onOpen={openProject} />
						</div>

						<div
							class={resizer() + " " + resizerRight()}
							role="separator"
							aria-orientation="vertical"
							aria-label="Resize project panel"
							tabIndex={0}
							onPointerDown={startResize("nav")}
							onKeyDown={onResizeKey("nav")}
						/>
					</>
				)}
			</div>

			<div class={mainWrap()}>
				<div ref={dockHostRef} class={dockHostCss()} />

				<div ref={overlayRef} class={overlay()}>
					<div class={overlayHead()}>
						<span ref={overlayTitleRef} class={overlayTitle()} />

						<wa-button ref={overlayCloseRef} appearance="plain" size="small" title="Close diff" aria-label="Close diff"><Icon node={ChevronRight} /></wa-button>
					</div>

					<div ref={overlayBodyRef} class={overlayBody()} />
				</div>
			</div>

			{/* The aside slot stays mounted across collapse so the imperatively-rendered git panel (mounted once, in
			    the effect below) survives — collapsed just hides it and shows the rail. Its header (with the collapse
			    button, passed in above) is the panel's own. The children are KEYED: unkeyed, a sibling swapping in
			    or out can make preact reuse the git panel's host <div> for another element, stamping that element's
			    class and children onto it — the panel then renders inside it. */}
			<div slot="aside" class={rhsCollapsed ? railRegion() : sideCol() + " " + asidePane()}>
				{rhsCollapsed && (
					<RailContent
						key="rail"
						items={[
							{ "node": PanelRight, "label": "Changes", "title": "Expand changes panel", "onClick": () => { setRhsCollapsed(false); } },
						// placeholders to preview the stacked look — settle final contents next
							{ "node": GitCommit, "label": "Commit", "title": "Commit", "onClick": () => undefined },
							{ "node": History, "label": "History", "title": "History", "onClick": () => undefined }
						]}
					/>
				)}

				<div key="git-panel" ref={gitPanelRef} class={rhsCollapsed ? hiddenBox() : sideHost()} />

				{!rhsCollapsed && (
					<div
						key="resizer"
						class={resizer() + " " + resizerLeft()}
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize changes panel"
						tabIndex={0}
						onPointerDown={startResize("aside")}
						onKeyDown={onResizeKey("aside")}
					/>
				)}
			</div>

			{AccountDialog !== undefined && <AccountDialog onClose={() => { setAccountDialog(undefined); }} />}
			{errorId !== undefined && (
				<wa-callout variant="danger" size="small" class={errorNotice()}>
					<div class="wa-stack wa-gap-2xs">
						<span>Something went wrong, and we've been told. If you get in touch about it, quote <strong>{errorId}</strong>.</span>
						<wa-button size="small" appearance="plain" onClick={() => { setErrorId(undefined); }}>Dismiss</wa-button>
					</div>
				</wa-callout>
			)}
		</wa-page>
	);
}

/** Build the shell chrome, iframe the app, and wire the LHS picker over the hub. */
export function renderShell(): void {
	// Load milestones (with main.tsx's shell/import and the app iframe's own), for load investigations.
	performance.mark("shell/render");
	injectGlobals();
	render(<Shell />, document.body);
}
