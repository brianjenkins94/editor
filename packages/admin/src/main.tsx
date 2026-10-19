/**
 * The admin app (README.md). Signed out, Web Awesome's login card: one button, to the API's sign-in page (PAR, via
 * util/auth/client). Signed in, `GET /admin/me` says what the user's roles allow: nothing (a page that says so), or the
 * app shell (`<wa-page>`, its navigation in one slot) with the pages in views.tsx, by the address's hash.
 */
import "theme";
import "@awesome.me/webawesome/dist/components/page/page.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/relative-time/relative-time.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js";
import "theme/exceptions/account.css";
import "theme/exceptions/admin.css";
import { AccountPage } from "account";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ArchitecturePage } from "./architecture";
import { loginOf } from "./logins";
import { errorsPageFor } from "./errors";
import { TimelinePage } from "./timeline";
import { MailPage } from "./mail";
import type { Maintenance, SwitchState } from "./maintenance";
import { KillSwitch, MaintenanceBanner, PausedBanner, Switches } from "./maintenance";
import { get, session, SIGNED_OUT, submit } from "./session";
import { Audit, Overview, Permissions, Sessions, TrafficPage, UnusualPage, UserPage, Users } from "./views";

/** Your account (packages/account), through the admin API. */
const ACCOUNT = { "get": get, "submit": submit, "loginOf": loginOf };

interface Me { "user": string; "roles": string[]; "permissions": string[]; "maintenance": Maintenance; "switches": SwitchState[] }

/** Where the hash says we are: a page and its query. */
function useRoute(): { "path": string; "query": URLSearchParams } {
	const read = (): { "path": string; "query": URLSearchParams } => {
		const [path = "/", query = ""] = location.hash.replace(/^#/u, "").split("?");

		return { "path": path === "" ? "/" : path, "query": new URLSearchParams(query) };
	};
	const [route, setRoute] = useState(read);

	useEffect(() => {
		const changed = (): void => {
			setRoute(read());
		};

		window.addEventListener("hashchange", changed);

		return () => {
			window.removeEventListener("hashchange", changed);
		};
	}, []);

	return route;
}

function SignIn({ problem }: { "problem"?: string }) {
	const [busy, setBusy] = useState(false);

	return (
		<div class="auth-screen wa-stack wa-align-items-center wa-justify-content-center">
			<wa-card class="auth-card">
				<div class="wa-stack wa-gap-l">
					<h1 class="wa-heading-l">Admin</h1>
					<p class="wa-caption-m">Sign in to look after accounts, sign-ins and the audit log.</p>
					{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
					<wa-button variant="brand" loading={busy} onClick={() => {
						setBusy(true);
						session.signIn().catch(() => {
							setBusy(false);
						});
					}}>Sign in</wa-button>
				</div>
			</wa-card>
		</div>
	);
}

/** Signed in with no role: nothing to look after, but your own account (a password, C3; linking; passkeys). Open at
 *  `#/account`, so coming back from GitHub or our passkey page (`link`, `passkey` in the address) lands there to finish. */
function NoAccess({ me, onSignOut }: { "me": Me; "onSignOut": () => void }) {
	const [account, setAccount] = useState(() => location.hash === "#/account");

	if (account) {
		return (
			<main class="wa-stack wa-gap-l">
				<div>
					<wa-button
						appearance="plain"
						onClick={() => {
							history.replaceState(history.state, "", location.pathname + location.search);
							setAccount(false);
						}}
					>
						Back
					</wa-button>
				</div>
				<AccountPage api={ACCOUNT} />
			</main>
		);
	}

	return (
		<div class="auth-screen wa-stack wa-align-items-center wa-justify-content-center">
			<wa-card class="auth-card">
				<div class="wa-stack wa-gap-l">
					<h1 class="wa-heading-l">No access</h1>
					<p>You're signed in, but this sign-in holds no admin roles. <span class="mono wa-color-text-quiet">{me.user}</span></p>
					<p class="wa-color-text-quiet">Roles go with a sign-in made with GitHub or a passkey, or with an authenticator app as its second step.</p>
					<div class="wa-cluster">
						<wa-button
							appearance="outlined"
							onClick={() => {
								location.hash = "#/account";
								setAccount(true);
							}}
						>
							Your account
						</wa-button>
						<wa-button appearance="outlined" onClick={onSignOut}>Sign out</wa-button>
					</div>
				</div>
			</wa-card>
		</div>
	);
}

function Shell({ me, onSignOut }: { "me": Me; "onSignOut": () => void }) {
	const { path, query } = useRoute();
	const [login, setLogin] = useState<string | undefined>();
	const page = path === "/users" ? <Users />
		: path.startsWith("/users/") ? <UserPage id={decodeURIComponent(path.slice("/users/".length))} />
			: path === "/sessions" ? <Sessions />
				: path.startsWith("/sessions/") ? <TimelinePage id={decodeURIComponent(path.slice("/sessions/".length))} />
				: path === "/audit" ? <Audit query={query} />
					: path === "/traffic" ? <TrafficPage query={query} />
						: path === "/unusual" ? <UnusualPage />
							: path === "/architecture" ? <ArchitecturePage query={query} />
								: path === "/mail" ? <MailPage query={query} />
								: path === "/errors" || path.startsWith("/errors/") ? errorsPageFor(path)
									: path === "/account" ? <AccountPage api={ACCOUNT} />
								: <Overview switch={me.permissions.includes("maintenance:switch") ? <><KillSwitch maintenance={me.maintenance} /><Switches switches={me.switches} /></> : undefined} />;
	const link = (href: string, label: string, active: boolean) => <a href={href} data-drawer="close" class={active ? "wa-link-plain active" : "wa-link-plain"}>{label}</a>;

	useEffect(() => {
		void get<{ "users": { "id": string; "githubId": number | null }[] }>("/users").then(({ users }) => users.find((user) => user.id === me.user)).then((self) => (self === undefined || self.githubId === null ? undefined : loginOf(self.githubId))).then(setLogin, () => undefined);
	}, [me.user]);

	return (
		<wa-page>
			<header slot="header" class="wa-split">
				<div class="wa-cluster">
					<wa-button data-toggle-nav appearance="plain" class="wa-mobile-only">Menu</wa-button>
					<strong>Admin</strong>
				</div>
				<div class="wa-cluster wa-gap-s">
					<span class="wa-caption-m">{login ?? ""} {me.roles.map((role) => <wa-badge key={role} variant="brand">{role}</wa-badge>)}</span>
					<wa-button size="small" appearance="outlined" onClick={onSignOut}>Sign out</wa-button>
				</div>
			</header>
			<nav slot="navigation" class="wa-stack wa-gap-2xs">
				{link("#/", "Overview", path === "/")}
				{link("#/users", "Users", path.startsWith("/users"))}
				{link("#/sessions", "Sign-ins", path === "/sessions")}
				{link("#/audit", "Audit log", path === "/audit")}
				{link("#/unusual", "Unusual", path === "/unusual")}
				{link("#/errors", "Errors", path.startsWith("/errors"))}
				{link("#/mail", "Mail", path === "/mail")}
				{link("#/traffic", "Traffic", path === "/traffic")}
				{link("#/architecture", "Architecture", path === "/architecture")}
				{link("#/account", "Your account", path === "/account")}
			</nav>
			<main class="wa-stack wa-gap-l">
				<MaintenanceBanner maintenance={me.maintenance} canSwitch={me.permissions.includes("maintenance:switch")} />
				<PausedBanner switches={me.switches} canSwitch={me.permissions.includes("maintenance:switch")} />
				<Permissions.Provider value={me.permissions}>{page}</Permissions.Provider>
			</main>
		</wa-page>
	);
}

function App() {
	const [state, setState] = useState<{ "kind": "loading" } | { "kind": "signedOut"; "problem"?: string } | { "kind": "in"; "me": Me }>({ "kind": "loading" });
	const signOut = (): void => {
		void session.signOut().finally(() => {
			setState({ "kind": "signedOut" });
		});
	};

	useEffect(() => {
		const ended = (): void => {
			setState({ "kind": "signedOut", "problem": "Your sign-in ended. Sign in again." });
		};

		window.addEventListener(SIGNED_OUT, ended);

		void (async () => {
			try {
				await session.completeSignIn();
			} catch {
				setState({ "kind": "signedOut", "problem": "Signing in didn't complete. Try again." });

				return;
			}

			if (!session.isSignedIn()) {
				setState({ "kind": "signedOut" });

				return;
			}

			try {
				setState({ "kind": "in", "me": await get<Me>("/me") });
			} catch (error) {
				// Refused because the sign-in ended (an admin ended it, or it ran out): the client has signed out. Or the API is
				// down for maintenance (the kill switch), when only the owner gets through.
				const down = error instanceof Error && / 503$/u.test(error.message);

				setState({ "kind": "signedOut", "problem": down ? "The API is down for maintenance. Only the owner can sign in until it's back." : session.isSignedIn() ? "Couldn't reach the API." : "Your sign-in ended. Sign in again." });
			}
		})();

		return () => {
			window.removeEventListener(SIGNED_OUT, ended);
		};
	}, []);

	return state.kind === "loading" ? <div class="auth-screen wa-stack wa-align-items-center wa-justify-content-center"><wa-spinner /></div>
		: state.kind === "signedOut" ? <SignIn problem={state.problem} />
			: state.me.roles.length === 0 ? <NoAccess me={state.me} onSignOut={signOut} />
				: <Shell me={state.me} onSignOut={signOut} />;
}

render(<App />, document.querySelector("#app") as HTMLElement);
