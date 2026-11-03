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
 * The shell talks to the app over the hub: a shell hub linked to the app iframe, which a loaded repo's files are published
 * on (`project.openFiles`, main.tsx). The RHS review panel (git-panel.tsx, Web Awesome components of its own) is mounted
 * into the `aside` region.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ComponentChildren } from "preact";
import type { VsCodeColors } from "theme/vscode-colors";
import type { RemoteRequest } from "../shared/git-remote";
import type { RepoBinding } from "./github-auth";
import type { Reporting } from "./reporting";
import type { Session } from "./session";
import { createHub, createRpcClient, serve, windowTransport } from "@brianjenkins94/hub";
import { relayLoggerToHub, tapConsoleAndErrors } from "@brianjenkins94/observability";
import { logger } from "@brianjenkins94/util/logger";
import { ChevronRight, GitBranch, GitCommit, History, LogOut, PanelRight, RotateCcw } from "lucide";
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { code, toolbar } from "theme/recipes";
import { asidePane, dockHostCss, errorNotice, ghError, ghOk, injectGlobals, mainWrap, overlay, overlayBody, overlayTitle, popoverBody, railRegion, resizer, resizerLeft, sideCol, sideHost, spacer, topBar } from "theme/styles/shell";
import { applyVsCodeColors } from "theme/vscode-colors";
import { reportArchitecture } from "../shared/architecture";
import { reportShellMetrics } from "../shared/editor-metrics";
import { iconSvg } from "../shared/theme";
import { envRepo, showRepo } from "./address";
import { renderGitPanel } from "./git-panel";
import { forgetRetired, GITHUB_APP_INSTALL } from "./github-auth";
import { resetAddress } from "./reset";
import { createShellDock } from "./shell-dock";
import "theme/components/page";
import "theme/components/popover";
import "theme/components/button";
import "theme/components/callout";
import "theme/components/checkbox";
import "theme/components/divider";
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

// The resizable pane's limits (px). The min keeps it usable, the max caps it at a fraction of the viewport so it can't
// swallow the editor.
const PANE = { "asideDefault": 380, "asideMin": 300 };
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

/** A lucide icon rendered into a Web Awesome button. */
function Icon({ node }: { "node": Parameters<typeof iconSvg>[0] }) {
	return <span dangerouslySetInnerHTML={{ "__html": iconSvg(node, { "size": 17 }) }} />;
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
				<span key={item.label} class="wa-stack wa-gap-3xs wa-align-items-center">
					<wa-button appearance="plain" variant="neutral" size="small" pill title={item.title} aria-label={item.title} onClick={item.onClick}><Icon node={item.node} /></wa-button>

					<span class="wa-caption-3xs wa-text-center">{item.label}</span>
				</span>
			))}
		</>
	);
}

/** The shell chrome. Owns the shell hub and, once mounted, links it to the app iframe and mounts the review panel into
 *  the aside. */
function Shell() {
	// The pane starts collapsed (as a rail) so the editor gets the room by default; expand from the rail when needed.
	const [rhsCollapsed, setRhsCollapsed] = useState(true);
	const [asideWidth, setAsideWidth] = useState(() => loadPaneWidth("asideWidth", PANE.asideDefault));
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
	// The repository the workspace is a clone of (where a commit pushes): the workspace's own origin, asked once the app
	// answers (`git.origin`), and set again by each load.
	const [boundRepo, setBoundRepo] = useState<RepoBinding | undefined>(undefined);
	// Commit-back popover (the top-bar Commit button).
	const [commitOpen, setCommitOpen] = useState(false);
	const [commitMessage, setCommitMessage] = useState("");
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState<string | undefined>(undefined);
	const [commitResult, setCommitResult] = useState<string | undefined>(undefined);
	// (the branch a push goes to: the workspace's own, asked as the popover opens — a checkout since the load moves it)
	const [commitBranch, setCommitBranch] = useState<string | undefined>(undefined);
	// Reset popover (the top-bar Reset button): what a reset would lose — the workspace's uncommitted changes and the
	// commits no remote has, counted as it opens (null: they couldn't be) — and whether it signs out too.
	const [resetOpen, setResetOpen] = useState(false);
	const [resetLosing, setResetLosing] = useState<{ "changes": number; "unpushed": { "branch": string; "commits": number }[] } | null | undefined>(undefined);
	const [resetSignOut, setResetSignOut] = useState(false);

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

	// Mount-once wiring: the shell hub linked to the app iframe, and the review panel. A LAYOUT
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

		// A push from the workspace's git, and who its commits are by: the sign-in's, so the shell's (git-push.ts).
		serve(shellHub, "git.remote", async (args) => (await import("./git-push")).remote(args as RemoteRequest));
		serve(shellHub, "git.identity", async () => (await import("./git-push")).identity());
		const appFrame = dock.editorFrame;

		// Load the SAME page into the iframe; that instance sees `window.parent !== window` → main.tsx boots the app.
		performance.mark("shell/app-iframe");
		appFrame.src = location.href;

		reportArchitecture(shellHub); // this realm's hub + network (GitHub, Code Hike) on $sys.arch
		// …and its logs and spans (the GitHub data plane's, a repository's load, the reset's), on `$sys.log.shell`, and its
		// uncaught errors: debug-mcp and the monitor see the shell as they see every other context.
		relayLoggerToHub(shellHub, "shell");
		tapConsoleAndErrors(shellHub, "shell");

		hubRef.current = shellHub;
		// The session timeline's events and every realm's uncaught errors, to the API (shell/reporting.ts).
		void import("./reporting").then(({ startReporting }) => {
			reportingRef.current = startReporting(shellHub, setErrorId);
		});
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
		// And the shell draws in VS Code's colours, as the editor publishes them (theme/vscode-colors): the dock's windows,
		// the top bar, the panels and their popovers read as VS Code's.
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

		rpcRef.current = createRpcClient(shellHub);
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

	// Apply the pane's width to wa-page's CSS var (collapsed → the rail's). Clamp against the live max so a narrow viewport
	// can't leave it wider than the editor. Inline `setProperty` wins over the static `.wa-shell` defaults.
	useEffect(() => {
		pageRef.current?.style.setProperty("--aside-width", (rhsCollapsed ? RAIL_WIDTH : Math.min(asideWidth, paneMax())) + "px");
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

		const nudge = event.key === "ArrowLeft" ? 16 : -16;
		const max = paneMax();

		setAsideWidth((value) => Math.max(PANE.asideMin, Math.min(max, value + nudge)));
	};

	// On load: finish a sign-in this page is the end of, and if signed in, show who as (GitHub's login, fetched live through
	// the API's proxy: the API keeps no login; or the account's email). The retired PAT is deleted wherever one was kept.
	useEffect(() => {
		let cancelled = false;
		const signedOut = (): void => {
			setSignedInAs(undefined);
			setGithubUser(undefined);
		};

		forgetRetired();
		window.addEventListener("shell:signedOut", signedOut);

		void (async () => {
			const session = await import("./session");
			const span = githubLog.span("editor.shell.githubSession");

			try {
				if (await session.completeSignIn()) {
					span.info("signed in");
				}
			} catch (error) {
				setGithubError(error instanceof Error && error.message.includes("access_denied") ? "Sign-in was cancelled." : "Sign-in didn't complete. Try again.");
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

			// Only a workspace that's no repository's clone is replaced from the address. One the workspace couldn't say
			// (unanswered) is kept, as is another repository's clone, which asks: either may hold work not pushed anywhere.
			// (asked as the workbench answers: by then the app, which takes a load's files, listens too)
			void (async () => {
				const asked = await rpcRef.current?.request("git.origin", undefined, { "timeoutMs": 10_000, "waitForResponderMs": 120_000 }).then((origin) => ({ "origin": origin as RepoBinding | null }), (error: unknown) => ({ "error": errText(error) }));

				if (asked === undefined || "error" in asked) {
					githubLog.warn("the workspace's origin went unanswered: it's kept", asked ?? {});

					return;
				}

				const bound = asked.origin ?? undefined;

				setBoundRepo(bound);

				if (wanted === undefined || `${bound?.owner}/${bound?.repo}`.toLowerCase() === `${wanted.owner}/${wanted.repo}`.toLowerCase()) {
					return;
				}

				setGithubOpen(true);

				if (bound !== undefined) {
					setRepoInput(`${wanted.owner}/${wanted.repo}`);
					setLoadError(`This workspace is ${bound.owner}/${bound.repo}: Load replaces it, and whatever of it isn't pushed.`);

					return;
				}

				await loadRepo(`${wanted.owner}/${wanted.repo}`);
			})();

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
						// paused: packages/api/README.md O8, when GitHub is reached directly, public repos only).
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

		const span = githubLog.span("editor.shell.githubLoadRepo", { "repo": input.trim() });

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

	// Commit the workspace's changes and push them: the workbench's git (git-service.ts `git.pull`, `git.commit` with
	// every change, then `git.push` of the current branch, through this shell's sign-in: git-push.ts), as agents'
	// git_pull, git_commit and git_push do and the review panel commits a part of. First the branch is brought up to
	// GitHub's when that's a fast-forward (CI commits to main too), so the push is one; when it can't be — the two have
	// each moved on, or GitHub changed a file changed here — nothing is committed, and it says why. With nothing changed,
	// it pushes what's committed and not yet pushed. A push refused after the commit says so: the commit is made, and
	// pushing again is the button again.
	const commit = async (): Promise<void> => {
		const rpc = rpcRef.current;
		const message = commitMessage.trim();

		if (boundRepo === undefined || rpc === undefined) {
			setCommitError("Load a repo first");

			return;
		}

		if (message === "") {
			setCommitError("Enter a commit message");

			return;
		}

		setCommitting(true);
		setCommitError(undefined);
		setCommitResult(undefined);

		const span = githubLog.span("editor.shell.githubCommit", { "repo": boundRepo.owner + "/" + boundRepo.repo });
		let made: string | undefined;

		try {
			const pulled = await rpc.request("git.pull", {}, { "timeoutMs": 300_000 }) as { "ref": string; "outcome": string; "files"?: string[]; "conflicts"?: string[] };

			if (pulled.outcome === "diverged") {
				throw new Error(`GitHub's ${pulled.ref} and this workspace's have each moved on, so it can't catch up: that's a rebase or a merge`);
			}

			if (pulled.outcome === "conflicts") {
				throw new Error(`GitHub changed files you've changed here, so it can't catch up: ${(pulled.conflicts ?? []).join(", ")}`);
			}

			const caught = pulled.outcome === "fast-forwarded" ? `Caught up with GitHub (${String(pulled.files?.length ?? 0)} files). ` : "";
			// (a commit of every change reads every file's status: on this repository, 2,212 files with the page busy after its
			// load, more than a minute — as git_review's and git_commit's tools allow)
			const { files } = await rpc.request("git.status", undefined, { "timeoutMs": 120_000 }) as { "files": { "path": string }[] };
			// (`.silo/`'s own .gitignore and .gitattributes alone are nothing to commit: they go only with something else
			// under `.silo/`, git-engine.ts `stageSiloSeeds`)
			const committing = files.filter(({ path }) => path !== ".silo/.gitignore" && path !== ".silo/.gitattributes");

			if (committing.length > 0) {
				made = (await rpc.request("git.commit", { "message": message }, { "timeoutMs": 600_000 }) as { "oid": string }).oid.slice(0, 7);
				setCommitMessage("");
			}

			const pushed = await rpc.request("git.push", {}, { "timeoutMs": 300_000 }) as { "ref": string; "ok": boolean; "error"?: string };

			if (!pushed.ok) {
				throw new Error(`GitHub refused the push to ${pushed.ref}${pushed.error === undefined ? "" : `: ${pushed.error}`}`);
			}

			setCommitResult(caught + (made === undefined ? `Nothing to commit: pushed ${pushed.ref}` : `Committed ${made} and pushed ${pushed.ref}`));
			span.info("committed and pushed", { "files": committing.length, "ref": pushed.ref, "pulled": pulled.outcome, ...made === undefined ? {} : { "sha": made } });
		} catch (error) {
			const said = error instanceof Error ? error.message : "Commit failed";

			setCommitError(made === undefined ? said : `Committed ${made}, but not pushed: ${said}`);
			span.error("commit or push failed", { "error": errText(error), "status": statusOf(error), ...made === undefined ? {} : { "sha": made } });
		} finally {
			span.end();
			setCommitting(false);
		}
	};

	// The Commit popover's body: what it needs first, until it has it — then the repo it pushes to, and the message.
	const commitBody = (): ComponentChildren => {
		if (githubUser === undefined) {
			return <span class="wa-caption-2xs">Sign in with GitHub first.</span>;
		}

		if (boundRepo === undefined) {
			return <span class="wa-caption-2xs">Load a repo first — a commit is pushed to the repo the workspace came from.</span>;
		}

		return (
			<>
				<span class="wa-caption-2xs">
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

					<strong>{commitBranch ?? boundRepo.branch}</strong>
				</span>

				<wa-input
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

				{commitError !== undefined && <span class={"wa-caption-2xs " + ghError()}>{commitError}</span>}

				{commitResult !== undefined && (
					<span class={"wa-caption-2xs " + ghOk()}>
						{commitResult}
					</span>
				)}

				<div class="wa-cluster wa-gap-xs">
					<wa-button variant="brand" size="small" disabled={committing || commitMessage.trim() === ""} onClick={() => { void commit(); }}>{committing ? "Committing…" : "Commit and push"}</wa-button>
				</div>
			</>
		);
	};

	const openReset = async (): Promise<void> => {
		setResetOpen(true);
		setResetLosing(undefined);

		const rpc = rpcRef.current;
		const [status, unpushed] = await Promise.all([
			rpc?.request("git.status", undefined, { "timeoutMs": 30_000 }).then((answer) => answer as { "files": unknown[] }, () => undefined),
			rpc?.request("git.unpushed", undefined, { "timeoutMs": 30_000 }).then((answer) => answer as { "branch": string; "commits": number }[], () => undefined)
		]);

		setResetLosing(status === undefined || unpushed === undefined ? null : { "changes": status.files.length, "unpushed": unpushed });
	};

	// What a reset would lose, in words: "3 uncommitted changes and 2 commits not pushed (on rehearsal/cosmetic) would be lost."
	const lossOf = ({ changes, unpushed }: { "changes": number; "unpushed": { "branch": string; "commits": number }[] }): string => {
		const commits = unpushed.reduce((total, { "commits": count }) => total + count, 0);
		const parts = [
			...changes === 0 ? [] : [`${String(changes)} uncommitted change${changes === 1 ? "" : "s"}`],
			...commits === 0 ? [] : [`${String(commits)} commit${commits === 1 ? "" : "s"} not pushed (on ${unpushed.map(({ branch }) => branch).join(", ")})`]
		];

		return `${parts.join(" and ")} would be lost.`;
	};

	// The Reset popover's body: what goes, what it would lose here, and the reset (shell/reset.ts, from the address).
	const resetBody = (): ComponentChildren => (
		<>
			<span class="wa-caption-2xs">Everything this browser keeps for the editor goes — the workspace and its git, settings, caches, its service worker — and it loads again as new.</span>

			{resetLosing === undefined
				? <span class="wa-caption-2xs">Counting what isn't pushed…</span>
				: resetLosing === null
					? <span class={"wa-caption-2xs " + ghError()}>Couldn't count what isn't pushed: anything here not pushed is lost.</span>
					: resetLosing.changes === 0 && resetLosing.unpushed.length === 0
						? <span class="wa-caption-2xs">Everything here is committed and pushed.</span>
						: <span class={"wa-caption-2xs " + ghError()}>{lossOf(resetLosing)}</span>}

			<wa-checkbox size="small" checked={resetSignOut} onChange={(event: Event) => { setResetSignOut((event.target as HTMLInputElement).checked); }}>Sign out too</wa-checkbox>

			<div class="wa-cluster wa-gap-xs">
				<wa-button variant="danger" size="small" onClick={() => { location.assign(resetAddress(resetSignOut)); }}>Reset</wa-button>
			</div>
		</>
	);

	// Loading a repo, signed in or out: signed out, only a public one.
	const loadSection = (): ComponentChildren => (
		<>
			<span class="wa-font-weight-semibold wa-font-size-s">{githubUser === undefined ? "Load a public repo" : "Load a repo"}</span>

			<span class="wa-caption-2xs">Its files open in the workspace.</span>

			<wa-input
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

			{loadError !== undefined && <span class={"wa-caption-2xs " + ghError()}>{loadError}</span>}

			<div class="wa-cluster wa-gap-xs">
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
			<span class="wa-font-weight-semibold wa-font-size-s">GitHub</span>

			{signedInAs !== undefined
				? (
						<>
							<span class="wa-font-size-xs">
								Signed in as
								{" "}

								<strong>{signedInAs}</strong>
							</span>

							{githubUser !== undefined
								? (
										<span class="wa-caption-2xs">
											A private repo needs the editor's GitHub App on it.
											{" "}

											<a class="wa-link wa-text-nowrap" href={GITHUB_APP_INSTALL} target="_blank" rel="noreferrer noopener">Choose repositories →</a>
										</span>
									)
								: <span class="wa-caption-2xs">Public repos load as signed out. Private repos and commits need a sign-in with GitHub.</span>}

							<div class="wa-cluster wa-gap-xs">
								<wa-button appearance="outlined" size="small" onClick={() => { void openAccount(); }}>Your account…</wa-button>
							</div>

							<wa-divider />

							<span class="wa-font-weight-semibold wa-font-size-s">Where you're signed in</span>

							{mySessions === undefined
								? <span class="wa-caption-2xs">Loading…</span>
								: mySessions.map((session) => (
										<div class="wa-split wa-gap-xs" key={session.id}>
											<span class="wa-stack wa-gap-0">
												<span class="wa-font-size-xs">
													{session.label ?? "A browser"}

													{session.current ? " · this browser" : ""}
												</span>

												<span class="wa-caption-2xs">
													last used
													{" "}

													<wa-relative-time date={new Date(session.lastUsedAt).toISOString()} />
												</span>
											</span>

											{!session.current && <wa-button appearance="plain" size="small" disabled={githubBusy} onClick={() => { void endOtherSession(session.id); }}>Sign out</wa-button>}
										</div>
									))}

							{githubError !== undefined && <span class={"wa-caption-2xs " + ghError()}>{githubError}</span>}

							<div class="wa-cluster wa-gap-xs">
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
											<span class={"wa-caption-2xs " + ghError()}>{githubUser !== undefined ? "Deleting your account ends every session at once and takes away the editor's GitHub App's access. It's kept 30 days, when signing in again brings it back; after that nothing we keep points at you. Your repositories on GitHub aren't touched." : "Deleting your account ends every session at once. It's kept 30 days, when signing in again brings it back; after that nothing we keep points at you."}</span>

											<div class="wa-cluster wa-gap-xs">
												<wa-button variant="danger" size="small" disabled={githubBusy} onClick={() => { void deleteAccount(); }}>Delete my account</wa-button>

												<wa-button appearance="plain" size="small" disabled={githubBusy} onClick={() => { setConfirmingDelete(false); }}>Cancel</wa-button>
											</div>
										</>
									)
								: <wa-button appearance="plain" variant="danger" size="small" disabled={githubBusy} onClick={() => { setConfirmingDelete(true); }}>Delete account…</wa-button>}
						</>
					)
				: signInHere && apiDown
					? <span class="wa-caption-2xs">Signing in is down for maintenance. Everything else works as signed out, and public repos load.</span>
					: signInHere
						? (
								<>
									<span class="wa-caption-2xs">Optional: everything here works without an account. Sign in with GitHub for private repos and commits (GitHub's token stays on the editor's server: this browser never holds it), or with your email.</span>

									{githubNotice !== undefined && <span class={"wa-caption-2xs " + ghOk()}>{githubNotice}</span>}

									{githubError !== undefined && <span class={"wa-caption-2xs " + ghError()}>{githubError}</span>}

									<div class="wa-cluster wa-gap-xs">
										<wa-button variant="brand" size="small" disabled={githubBusy} onClick={() => { void signInGithub(); }}>{githubBusy ? "Signing in…" : "Sign in"}</wa-button>
									</div>
								</>
							)
						: <span class="wa-caption-2xs">Signing in isn't available on this copy of the editor.</span>}

			<wa-divider />

			{loadSection()}
		</>
	);

	const shellClass = ["wa-shell", rhsCollapsed ? "rhs-collapsed" : ""].filter(Boolean).join(" ");

	return (
		<wa-page ref={pageRef} class={shellClass} mobile-breakpoint="0" disable-navigation-toggle>
			<div slot="header" class={"wa-cluster wa-flex-nowrap wa-gap-2xs " + topBar()}>
				<span class="wa-font-weight-semibold wa-color-text-quiet">editor</span>

				<wa-button
					id="shell-commit"
					appearance="plain"
					size="small"
					title={boundRepo !== undefined ? "Commit and push to " + boundRepo.owner + "/" + boundRepo.repo : "Commit and push"}
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
							void rpcRef.current?.request("git.branch", undefined, { "timeoutMs": 10_000 }).then((branches) => {
								setCommitBranch((branches as { "current"?: string }).current);
							}, () => {
								setCommitBranch(undefined);
							});
						}
					}}
					onwa-hide={(event: Event) => {
						if (event.target === event.currentTarget) {
							setCommitOpen(false);
						}
					}}
				>
					<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Commit to GitHub">
						<span class="wa-font-weight-semibold wa-font-size-s">Commit and push</span>

						{commitBody()}
					</div>
				</wa-popover>

				<span class={spacer()} />

				<wa-button id="shell-reset" appearance="plain" size="small" title="Reset the editor" aria-label="Reset the editor"><Icon node={RotateCcw} /></wa-button>

				<wa-popover
					for="shell-reset"
					placement="bottom-end"
					open={resetOpen}
					onwa-show={(event: Event) => {
						if (event.target === event.currentTarget) {
							void openReset();
						}
					}}
					onwa-hide={(event: Event) => {
						if (event.target === event.currentTarget) {
							setResetOpen(false);
						}
					}}
				>
					<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Reset the editor">
						<span class="wa-font-weight-semibold wa-font-size-s">Reset the editor</span>

						{resetBody()}
					</div>
				</wa-popover>

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

			<div class={mainWrap()}>
				<div ref={dockHostRef} class={dockHostCss()} />

				<div ref={overlayRef} class={overlay()}>
					<div class={toolbar({ "density": "compact", "css": { "height": "34px" } }) + " wa-cluster wa-flex-nowrap wa-gap-2xs"}>
						<span ref={overlayTitleRef} class={code() + " wa-font-size-xs wa-text-truncate " + overlayTitle()} />

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
			<div slot="aside" class={rhsCollapsed ? "wa-stack wa-gap-m wa-align-items-center " + railRegion() : "wa-stack wa-gap-0 " + sideCol() + " " + asidePane()}>
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

			{AccountDialog !== undefined && <AccountDialog onClose={() => { setAccountDialog(undefined); }} />}

			{errorId !== undefined && (
				<wa-callout variant="danger" size="small" class={errorNotice()}>
					<div class="wa-stack wa-gap-2xs">
						<span>
							Something went wrong, and we've been told. If you get in touch about it, quote
							<strong>{errorId}</strong>
							.
						</span>

						<wa-button size="small" appearance="plain" onClick={() => { setErrorId(undefined); }}>Dismiss</wa-button>
					</div>
				</wa-callout>
			)}
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
