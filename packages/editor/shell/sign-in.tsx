/** @jsxImportSource preact */
/**
 * Signing in (session.ts), optional: a full-page round trip through the API's sign-in page, finished as this page loads
 * again; who's signed in (GitHub's login, fetched live through the API's proxy — the API keeps no login — or the
 * account's email); where you're signed in, each session's way out and the account's; and your account, in a dialog
 * (account-dialog.tsx). The session (oauth4webapi), the client (fido) and the dialog are imported only when needed, so
 * they code-split out of the cold-start bundle. Its section is the GitHub popover's first (github-control.tsx).
 */
import type { FunctionComponent } from "preact";
import type { ShellFeature } from "./feature";
import type { Session } from "./session";
import { LogOut } from "lucide";
import { useEffect } from "preact/hooks";
import { ghError, ghOk } from "theme/styles/shell";
import { createStore, errText, githubLog, shared, statusOf, useStore } from "./feature";
import { forgetRetired, GITHUB_APP_INSTALL } from "./github-auth";
import { Icon } from "./icon";

const state = createStore<{
	"busy": boolean;
	"error"?: string;
	"notice"?: string;
	/** Whether this copy of the editor can sign in at all. */
	"here": boolean;
	/** The API down for maintenance (its kill switch): no sign-in offered; signed in, the editor carries on as signed out. */
	"apiDown": boolean;
	/** Where you're signed in (listed when the popover opens, signed in). */
	"sessions"?: Session[];
	/** The account deletion's confirmation step. */
	"confirmingDelete": boolean;
	"AccountDialog"?: FunctionComponent<{ "onClose": () => void }>;
}>({ "busy": false, "here": false, "apiDown": false, "confirmingDelete": false });

let settle: () => void;

/** Settles once this page has finished a sign-in it's the end of (or found none): what a load from the address waits on,
 *  so a private repository is read signed in. */
export const signInSettled = new Promise<void>((resolve) => {
	settle = resolve;
});

function signedOut(): void {
	shared.set({ "signedInAs": undefined, "githubUser": undefined });
}

/** Your account, in a dialog (account-dialog.tsx, loaded when first opened). */
async function openAccount(): Promise<void> {
	const { "AccountDialog": dialog } = await import("./account-dialog");

	state.set({ "AccountDialog": dialog });
}

/** On load: finish a sign-in this page is the end of, and if signed in, say who as. The retired PAT is deleted wherever
 *  one was kept. */
async function start(): Promise<void> {
	forgetRetired();
	window.addEventListener("shell:signedOut", signedOut);

	const session = await import("./session");
	const span = githubLog.span("editor.shell.sign-in.githubSession");

	try {
		if (await session.completeSignIn()) {
			span.info("signed in");
		}
	} catch (error) {
		state.set({ "error": error instanceof Error && error.message.includes("access_denied") ? "Sign-in was cancelled." : "Sign-in didn't complete. Try again." });
		shared.set({ "githubOpen": true });
		span.error("sign-in failed", { "error": errText(error) });
	}

	state.set({ "here": session.canSignIn() });

	// Back from GitHub, connecting it to the account, or from our passkey page, adding one (packages/account finishes
	// either): its dialog, open again.
	if (session.isSignedIn() && /[?&](?:link|link_error|passkey)=/u.test(location.search)) {
		await openAccount();
	}

	settle();

	try {
		if (session.isSignedIn() && await session.apiDown()) {
			state.set({ "apiDown": true });
		} else if (session.isSignedIn()) {
			const me = await session.account();

			if (me.githubId === null) {
				shared.set({ "signedInAs": me.email?.address ?? "your account" });
			} else {
				// Signed in either way; GitHub's login only when it can be read (not while the API's GitHub proxy is paused:
				// packages/api/README.md O8, when GitHub is reached directly, public repos only).
				shared.set({ "signedInAs": "your GitHub account" });

				const { connectGitHub } = await import("./github");
				const { login } = await (await connectGitHub()).viewer();

				shared.set({ "signedInAs": login, "githubUser": login });
			}
		}
	} catch (error) {
		span.warn("couldn't read who's signed in", { "error": errText(error), "status": statusOf(error) });
	} finally {
		span.end();
	}
}

/** Sign in: a full-page round trip through the API's sign-in page (session.ts); this page loads again at the end of it. */
async function signInGithub(): Promise<void> {
	state.set({ "busy": true, "error": undefined });

	try {
		await (await import("./session")).signIn();
	} catch (error) {
		state.set({ "busy": false, "error": "Couldn't start signing in." });
		githubLog.error("sign-in didn't start", { "error": errText(error) });
	}
}

/** A session's way out, an account's way out: each ends here signed out, with what happened said. */
async function accountAction(run: (session: typeof import("./session")) => Promise<string | undefined>, failure: string): Promise<void> {
	state.set({ "busy": true, "error": undefined, "notice": undefined });

	try {
		state.set({ "notice": await run(await import("./session")) });
	} catch (error) {
		state.set({ "error": failure });
		githubLog.error(failure, { "error": errText(error) });
	} finally {
		state.set({ "confirmingDelete": false, "busy": false });
	}
}

async function endOtherSession(id: string): Promise<void> {
	await accountAction(async (session) => {
		await session.endSession(id);
		state.set({ "sessions": await session.sessions() });

		return undefined;
	}, "Couldn't end that session.");
}

async function signOutEverywhere(): Promise<void> {
	await accountAction(async (session) => {
		await session.signOutEverywhere();
		signedOut();
		state.set({ "sessions": undefined });

		return "Signed out everywhere.";
	}, "Couldn't sign out everywhere.");
}

async function deleteAccount(): Promise<void> {
	await accountAction(async (session) => {
		const { githubAuthorizationRevoked } = await session.deleteAccount();
		const github = shared.get().githubUser !== undefined;

		signedOut();
		state.set({ "sessions": undefined });

		if (!github) {
			return "Your account is deleted. Sign in within 30 days to bring it back; after that it's gone for good.";
		}

		return githubAuthorizationRevoked ? "Your account is deleted, and the editor's GitHub App no longer has access. Sign in within 30 days to bring it back; after that it's gone for good." : "Your account is deleted. GitHub didn't confirm the app's access ended: remove it under GitHub's Settings → Applications.";
	}, "Couldn't delete the account.");
}

/** Sign out: the session ends at the API (and GitHub's token with it), and this browser forgets its key. */
async function signOutGithub(): Promise<void> {
	state.set({ "busy": true });

	try {
		await (await import("./session")).signOut();
	} finally {
		signedOut();
		state.set({ "error": undefined, "busy": false });
		shared.set({ "githubOpen": false });
	}
}

/** The GitHub popover's first section: who's signed in (and signing out), or signing in, which is optional. */
export function SignInSection() {
	const { signedInAs, githubUser, githubOpen } = useStore(shared);
	const { busy, error, notice, here, apiDown, sessions, confirmingDelete } = useStore(state);

	// Before offering a sign-in: whether the API is down for maintenance, asked when the popover opens signed out.
	useEffect(() => {
		if (!githubOpen || signedInAs !== undefined || !here) {
			return;
		}

		void import("./session").then(async (session) => session.apiDown()).then((down) => {
			state.set({ "apiDown": down });
		});
	}, [githubOpen, signedInAs, here]);

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
					state.set({ "sessions": list });
				}
			} catch (failure) {
				githubLog.warn("couldn't list sessions", { "error": errText(failure) });
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [githubOpen, signedInAs]);

	if (signedInAs !== undefined) {
		return (
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

				{sessions === undefined
					? <span class="wa-caption-2xs">Loading…</span>
					: sessions.map((session) => (
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

								{!session.current && <wa-button appearance="plain" size="small" disabled={busy} onClick={() => { void endOtherSession(session.id); }}>Sign out</wa-button>}
							</div>
						))}

				{error !== undefined && <span class={"wa-caption-2xs " + ghError()}>{error}</span>}

				<div class="wa-cluster wa-gap-xs">
					<wa-button appearance="outlined" size="small" disabled={busy} onClick={() => { void signOutGithub(); }}>
						<Icon node={LogOut} />

						{" "}
						Sign out
					</wa-button>

					<wa-button appearance="plain" size="small" disabled={busy} onClick={() => { void signOutEverywhere(); }}>Sign out everywhere</wa-button>
				</div>

				{confirmingDelete
					? (
							<>
								<span class={"wa-caption-2xs " + ghError()}>{githubUser !== undefined ? "Deleting your account ends every session at once and takes away the editor's GitHub App's access. It's kept 30 days, when signing in again brings it back; after that nothing we keep points at you. Your repositories on GitHub aren't touched." : "Deleting your account ends every session at once. It's kept 30 days, when signing in again brings it back; after that nothing we keep points at you."}</span>

								<div class="wa-cluster wa-gap-xs">
									<wa-button variant="danger" size="small" disabled={busy} onClick={() => { void deleteAccount(); }}>Delete my account</wa-button>

									<wa-button appearance="plain" size="small" disabled={busy} onClick={() => { state.set({ "confirmingDelete": false }); }}>Cancel</wa-button>
								</div>
							</>
						)
					: <wa-button appearance="plain" variant="danger" size="small" disabled={busy} onClick={() => { state.set({ "confirmingDelete": true }); }}>Delete account…</wa-button>}
			</>
		);
	}

	if (here && apiDown) {
		return <span class="wa-caption-2xs">Signing in is down for maintenance. Everything else works as signed out, and public repos load.</span>;
	}

	if (!here) {
		return <span class="wa-caption-2xs">Signing in isn't available on this copy of the editor.</span>;
	}

	return (
		<>
			<span class="wa-caption-2xs">Optional: everything here works without an account. Sign in with GitHub for private repos and commits (GitHub's token stays on the editor's server: this browser never holds it), or with your email.</span>

			{notice !== undefined && <span class={"wa-caption-2xs " + ghOk()}>{notice}</span>}

			{error !== undefined && <span class={"wa-caption-2xs " + ghError()}>{error}</span>}

			<div class="wa-cluster wa-gap-xs">
				<wa-button variant="brand" size="small" disabled={busy} onClick={() => { void signInGithub(); }}>{busy ? "Signing in…" : "Sign in"}</wa-button>
			</div>
		</>
	);
}

export const signIn: ShellFeature = {
	"start": () => {
		void start();
	},
	"Overlay": () => {
		const { AccountDialog } = useStore(state);

		return AccountDialog === undefined ? null : <AccountDialog onClose={() => { state.set({ "AccountDialog": undefined }); }} />;
	}
};
