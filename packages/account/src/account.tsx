/** @jsxImportSource preact */
/**
 * Your account (README.md; packages/api/SIGN-IN.md, C3–C7): how you sign in (GitHub, your email, a password), setting or
 * changing your password (a code to your email first, the action's own check), and two-factor. The same for the editor
 * and the admin app: each passes how it reaches the API's account routes (`AccountApi`), and registers the Web Awesome
 * components used here (button, callout, input, spinner).
 */
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { renderSVG } from "uqr";

/** How the app reaches its account routes (`/account…`: the admin app's under /admin, the editor's at the API's root). */
export interface AccountApi {
	"get": <T>(path: string) => Promise<T>;
	"submit": <T>(path: string, form: Record<string, string>) => Promise<{ "ok": boolean; "status": number; "body": Partial<T> & { "reason"?: string } }>;
	/** A GitHub id's login, for showing; none says the id. */
	"loginOf"?: (githubId: number) => Promise<string | undefined>;
}

const Api = createContext<AccountApi | undefined>(undefined);

export interface Account { "user": string; "githubId": number | null; "email": { "address": string; "verifiedAt": number | null } | null; "password": { "setAt": number } | null; "mfa": { "enrolledAt": number; "recoveryLeft": number } | null; "emailMfa": { "enrolledAt": number } | null; "passkeys": { "id": string; "createdAt": number; "lastUsedAt": number | null; "synced": boolean }[] }

/** What a refusal's reason means, in words (packages/api/src/password.ts and email.ts say it plainly already; these few
 *  read better for a person). */
const WORDS: Record<string, string> = {
	"password: code wrong": "That isn't the code we sent.",
	"code wrong": "That isn't the code we sent.",
	"code expired": "That code has expired. Ask for another.",
	"too many tries": "Too many tries. Wait a minute, then try again.",
	"a code was sent less than a minute ago": "A code was sent less than a minute ago. Wait a moment, then ask again."
};

/** A refusal's reason, in words. */
const said = (reason = ""): string => WORDS[reason] ?? (reason === "" ? "That didn't work. Try again." : `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}.`);

/** A form POST: its body, or what's wrong with it, in words. */
async function postWithReason<T>(submit: AccountApi["submit"], path: string, form: Record<string, string>): Promise<{ "ok": true; "body": Partial<T> } | { "ok": false; "reason": string }> {
	try {
		const answer = await submit<T>(path, form);

		return answer.ok ? { "ok": true, "body": answer.body } : { "ok": false, "reason": said(answer.body.reason) };
	} catch {
		return { "ok": false, "reason": "Couldn't reach the API." };
	}
}

/** A way in that's another account's (the API's 409): whose, and whether it holds nothing else, so it can be merged in. */
interface Taken { "account": string; "mergeable": boolean }

/** A link's answer: done, another account's (Taken), or what's wrong in words. */
async function linkWith(submit: AccountApi["submit"], path: string, form: Record<string, string>): Promise<{ "ok": true } | { "taken": Taken } | { "reason": string }> {
	try {
		const answer = await submit<Taken>(path, form);

		if (answer.ok) {
			return { "ok": true };
		}

		return answer.status === 409 && typeof answer.body.account === "string" ? { "taken": { "account": answer.body.account, "mergeable": answer.body.mergeable === true } } : { "reason": said(answer.body.reason) };
	} catch {
		return { "reason": "Couldn't reach the API." };
	}
}

/** What to say of a way in that's another account's: merge it in (it holds nothing else), or keep them apart. */
function TakenBy({ what, taken, busy, onMerge }: { "what": string; "taken": Taken; "busy": boolean; "onMerge": () => void }) {
	if (!taken.mergeable) {
		return (
			<wa-callout variant="warning">
				That {what} is another account's (<span class="account-mono">{taken.account.slice(0, 8)}</span>), which holds more than it: a password, two-factor, a role or another way in. Sign in with it and delete that account first, or keep them apart.
			</wa-callout>
		);
	}

	return (
		<wa-callout variant="warning">
			<div class="wa-stack wa-gap-s">
				<span>That {what} has an account of its own (<span class="account-mono">{taken.account.slice(0, 8)}</span>), with nothing else in it. Merge it into this one? That account is deleted, as deleting an account is, and its sign-ins end.</span>
				<div><wa-button variant="brand" loading={busy} onClick={onMerge}>Merge it into this account</wa-button></div>
			</div>
		</wa-callout>
	);
}

/** Connecting GitHub (SIGN-IN.md, "Linking accounts"): GitHub's authorize page, then back to this page with `link`,
 *  which this sign-in finishes. Needs a sign-in in the last 10 minutes: the API says so if not. */
function ConnectGitHub({ onChanged }: { "onChanged": () => void }) {
	const api = useContext(Api) as AccountApi;
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const [taken, setTaken] = useState<{ "link": string } & Taken | undefined>();
	const finish = async (link: string, merge: boolean): Promise<void> => {
		setBusy(true);
		setProblem(undefined);

		const answer = await linkWith(api.submit, "/account/github/finish", { "link": link, ...merge ? { "merge": "1" } : {} });

		setBusy(false);

		if ("taken" in answer) {
			setTaken({ "link": link, ...answer.taken });
		} else if ("reason" in answer) {
			setProblem(answer.reason);
		} else {
			onChanged();
		}
	};

	// Back from GitHub: the link (or why not) in the address, taken out of it at once.
	useEffect(() => {
		const here = new URL(location.href);
		const link = here.searchParams.get("link");
		const error = here.searchParams.get("link_error");

		if (link === null && error === null) {
			return;
		}

		here.searchParams.delete("link");
		here.searchParams.delete("link_error");
		history.replaceState(history.state, "", here.href);

		if (link === null) {
			setProblem(error === "access_denied" ? "Connecting GitHub was cancelled." : "GitHub didn't connect. Try again.");
		} else {
			void finish(link, false);
		}
	}, []);

	return (
		<div class="wa-stack">
			<p>Connect GitHub to sign in with it too, and, in the editor, to open private repositories and commit.</p>
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			{taken !== undefined && <TakenBy what="GitHub account" taken={taken} busy={busy} onMerge={() => { void finish(taken.link, true); }} />}
			<div>
				<wa-button
					loading={busy}
					onClick={() => {
						setBusy(true);
						setProblem(undefined);
						void postWithReason<{ "location": string }>(api.submit, "/account/github", { "return": location.href }).then((answer) => {
							if (answer.ok && answer.body.location !== undefined) {
								location.assign(answer.body.location);
							} else {
								setBusy(false);
								setProblem("reason" in answer ? answer.reason : undefined);
							}
						});
					}}
				>
					Connect GitHub
				</wa-button>
			</div>
		</div>
	);
}

/** Passkeys (SIGN-IN.md, "Passkeys"): the account's, each removable; adding one goes to our passkey page (passkeys
 *  belong to the API's host, so they're made there) and back here with `passkey`, which this sign-in finishes. Adding and
 *  removing need a sign-in in the last 10 minutes: the API says so if not. */
function Passkeys({ account, onChanged }: { "account": Account; "onChanged": () => void }) {
	const api = useContext(Api) as AccountApi;
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const [added, setAdded] = useState(false);
	const call = async (path: string, form: Record<string, string>, then: () => void): Promise<void> => {
		setBusy(true);
		setProblem(undefined);

		const answer = await postWithReason(api.submit, path, form);

		setBusy(false);

		if ("reason" in answer) {
			setProblem(answer.reason);
		} else {
			then();
		}
	};

	// Back from our passkey page: the code in the address, taken out of it at once, and the passkey added.
	useEffect(() => {
		const here = new URL(location.href);
		const code = here.searchParams.get("passkey");

		if (code === null) {
			return;
		}

		here.searchParams.delete("passkey");
		history.replaceState(history.state, "", here.href);
		void call("/account/passkey/finish", { "passkey": code }, () => {
			setAdded(true);
			onChanged();
		});
	}, []);

	const when = (at: number): string => new Date(at).toLocaleDateString();

	return (
		<div class="wa-stack">
			<p>Sign in with your device instead: its fingerprint, face or PIN, or your password manager. Nothing to type, and it works only on our own sign-in page, so it can't be phished.</p>
			{added && <wa-callout variant="success">Your passkey is added. Choose “Sign in with a passkey” next time.</wa-callout>}
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			{account.passkeys.map((passkey) => (
				<div class="wa-cluster wa-gap-s" key={passkey.id}>
					<span>
						Added {when(passkey.createdAt)}, {passkey.lastUsedAt === null ? "not used yet" : `last used ${when(passkey.lastUsedAt)}`}
						<span class="account-muted"> · {passkey.synced ? "synced" : "this device only"}</span>
					</span>
					<wa-button
						size="small"
						appearance="plain"
						variant="danger"
						loading={busy}
						onClick={() => {
							void call("/account/passkey/remove", { "id": passkey.id }, onChanged);
						}}
					>
						Remove
					</wa-button>
				</div>
			))}
			<div>
				<wa-button
					loading={busy}
					onClick={() => {
						setBusy(true);
						setProblem(undefined);
						void postWithReason<{ "location": string }>(api.submit, "/account/passkey", { "return": location.href }).then((answer) => {
							if (answer.ok && answer.body.location !== undefined) {
								location.assign(answer.body.location);
							} else {
								setBusy(false);
								setProblem("reason" in answer ? answer.reason : undefined);
							}
						});
					}}
				>
					Add a passkey
				</wa-button>
			</div>
		</div>
	);
}

/** Adding an email to a GitHub account: the address, then the code we send it. Needs a sign-in in the last 10 minutes. */
function AddEmail({ onChanged }: { "onChanged": () => void }) {
	const api = useContext(Api) as AccountApi;
	const [sent, setSent] = useState<string | undefined>();
	const [code, setCode] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const [taken, setTaken] = useState<Taken | undefined>();
	const add = async (address: string, typed: string, merge: boolean): Promise<void> => {
		setBusy(true);
		setProblem(undefined);

		const answer = await linkWith(api.submit, "/account/email", { "address": address, "code": typed, ...merge ? { "merge": "1" } : {} });

		setBusy(false);

		if ("taken" in answer) {
			setCode(typed);
			setTaken(answer.taken);
		} else if ("reason" in answer) {
			setProblem(answer.reason);
		} else {
			onChanged();
		}
	};

	if (sent === undefined) {
		return (
			<form
				class="wa-cluster wa-gap-s account-code-form"
				onSubmit={(event) => {
					event.preventDefault();

					const address = (event.currentTarget.elements.namedItem("address") as HTMLInputElement).value;

					setBusy(true);
					setProblem(undefined);
					void postWithReason<{ "sent": boolean }>(api.submit, "/account/email/code", { "address": address }).then((answer) => {
						setBusy(false);

						if (answer.ok) {
							setSent(address);
						} else {
							setProblem("reason" in answer ? answer.reason : undefined);
						}
					});
				}}
			>
				<wa-input name="address" type="email" label="Add an email, to sign in with it too" autocomplete="email" required />
				<wa-button type="submit" loading={busy}>Email me a code</wa-button>
				{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			</form>
		);
	}

	return (
		<div class="wa-stack">
			{taken === undefined
				? (
					<form
						class="wa-cluster wa-gap-s account-code-form"
						onSubmit={(event) => {
							event.preventDefault();
							void add(sent, (event.currentTarget.elements.namedItem("code") as HTMLInputElement).value, false);
						}}
					>
						<wa-input name="code" label={`The code we sent to ${sent}`} placeholder="ABCD-2345" autocomplete="one-time-code" required />
						<wa-button type="submit" loading={busy}>Add it</wa-button>
					</form>
				)
				: <TakenBy what="email" taken={taken} busy={busy} onMerge={() => { void add(sent, code ?? "", true); }} />}
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			<div>
				<wa-button
					appearance="plain"
					onClick={() => {
						setSent(undefined);
						setTaken(undefined);
						setProblem(undefined);
					}}
				>
					Use another address
				</wa-button>
			</div>
		</div>
	);
}

function SetPassword({ account, onSet }: { "account": Account; "onSet": () => void }) {
	const api = useContext(Api) as AccountApi;
	const [sent, setSent] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const [done, setDone] = useState(false);

	if (account.email === null) {
		return <p class="account-muted">A password signs in with your email, and this account has none yet: add one above.</p>;
	}

	if (done) {
		return <wa-callout variant="success">Your password is set. Sign in with your email and it next time.</wa-callout>;
	}

	if (sent === undefined) {
		return (
			<div class="wa-stack">
				<p>{account.password === null ? "Set a password" : "Change your password"}: we'll send a code to {account.email.address} first, to be sure it's you.</p>
				{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
				<div>
					<wa-button
						variant="brand"
						loading={busy}
						onClick={() => {
							setBusy(true);
							setProblem(undefined);
							void postWithReason<{ "address": string }>(api.submit, "/account/password/code", {}).then((answer) => {
								setBusy(false);

								if (answer.ok) {
									setSent(answer.body.address ?? account.email?.address);
								} else {
									setProblem("reason" in answer ? answer.reason : undefined);
								}
							});
						}}
					>
						Email me a code
					</wa-button>
				</div>
			</div>
		);
	}

	return (
		<form
			class="wa-stack"
			onSubmit={(event) => {
				event.preventDefault();

				const field = (name: string): string => (event.currentTarget.elements.namedItem(name) as HTMLInputElement).value;

				setBusy(true);
				setProblem(undefined);
				void postWithReason<{ "set": boolean }>(api.submit, "/account/password", { "code": field("code"), "password": field("password") }).then((answer) => {
					setBusy(false);

					if (answer.ok) {
						setDone(true);
						onSet();
					} else {
						setProblem("reason" in answer ? answer.reason : undefined);
					}
				});
			}}
		>
			<p class="account-muted">We sent a code to {sent}. It works for 10 minutes.</p>
			<wa-input name="code" label="Code" placeholder="ABCD-2345" autocomplete="one-time-code" required />
			<wa-input name="password" type="password" label="New password" hint="10 to 100 characters: letters, digits, spaces and the symbols on a US keyboard. Checked against known breaches." autocomplete="new-password" password-toggle required />
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			<div><wa-button type="submit" variant="brand" loading={busy}>Save the password</wa-button></div>
		</form>
	);
}

/** Recovery codes, shown the once they exist: to save somewhere safe. */
function RecoveryCodes({ codes }: { "codes": string[] }) {
	return (
		<wa-callout variant="warning">
			<div class="wa-stack wa-gap-s">
				<strong>Save these recovery codes somewhere safe.</strong>
				<span>Each gets you in once if you lose your authenticator app. They won't be shown again.</span>
				<div class="account-mono account-recovery">{codes.map((code) => <span key={code}>{code}</span>)}</div>
			</div>
		</wa-callout>
	);
}

/** Two-factor (C5): set it up (the app scans a QR code, then a code confirms it), or, when it's on, new recovery codes or
 *  turn it off, each with a code. Each needs a sign-in in the last 10 minutes: the API says so if not. */
function TwoFactor({ account, onChanged }: { "account": Account; "onChanged": () => void }) {
	const api = useContext(Api) as AccountApi;
	const [setup, setSetup] = useState<{ "secret": string; "uri": string } | undefined>();
	const [codes, setCodes] = useState<string[] | undefined>();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const call = async <T,>(path: string, form: Record<string, string>, then: (body: Partial<T>) => void): Promise<void> => {
		setBusy(true);
		setProblem(undefined);

		const answer = await postWithReason<T>(api.submit, path, form);

		setBusy(false);

		if ("reason" in answer) {
			setProblem(answer.reason);
		} else {
			then(answer.body);
		}
	};
	const withCode = (label: string, action: string, path: string, then: (body: Partial<{ "recoveryCodes": string[] }>) => void) => (
		<form
			class="wa-cluster wa-gap-s account-code-form"
			onSubmit={(event) => {
				event.preventDefault();
				void call<{ "recoveryCodes": string[] }>(path, { "code": (event.currentTarget.elements.namedItem("code") as HTMLInputElement).value }, then);
			}}
		>
			<wa-input name="code" label={label} autocomplete="one-time-code" required />
			<wa-button type="submit" loading={busy}>{action}</wa-button>
		</form>
	);

	return (
		<div class="wa-stack">
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			{codes !== undefined && <RecoveryCodes codes={codes} />}
			{account.mfa === null && setup === undefined && (
				<>
					<p>Add a second step to signing in with your email or a password: a code from an authenticator app (1Password, Google Authenticator, Authy…).</p>
					<div>
						<wa-button
							variant="brand"
							loading={busy}
							onClick={() => {
								void call<{ "secret": string; "uri": string }>("/account/mfa/start", {}, (body) => {
									setSetup({ "secret": body.secret ?? "", "uri": body.uri ?? "" });
								});
							}}
						>
							Set up an authenticator app
						</wa-button>
					</div>
				</>
			)}
			{account.mfa === null && setup !== undefined && (
				<div class="wa-stack">
					<p>Scan this with your authenticator app, then type the code it shows.</p>
					<img class="account-qr" alt="QR code for your authenticator app" src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.uri, { "border": 2 }))}`} />
					<p class="account-muted">Or enter this key by hand: <span class="account-mono">{setup.secret.replaceAll(/(.{4})/gu, "$1 ").trim()}</span></p>
					{withCode("Code from the app", "Turn on", "/account/mfa/confirm", (body) => {
						setCodes(body.recoveryCodes);
						setSetup(undefined);
						onChanged();
					})}
				</div>
			)}
			{account.mfa !== null && (
				<div class="wa-stack">
					<p>On since {new Date(account.mfa.enrolledAt).toLocaleDateString()}. {account.mfa.recoveryLeft} recovery code{account.mfa.recoveryLeft === 1 ? "" : "s"} left.</p>
					{withCode("Code from the app", "New recovery codes", "/account/mfa/recovery", (body) => {
						setCodes(body.recoveryCodes);
						onChanged();
					})}
					{withCode("Code from the app, or a recovery code", "Turn off", "/account/mfa/off", () => {
						setCodes(undefined);
						onChanged();
					})}
				</div>
			)}
		</div>
	);
}

/** Two-factor by email (C6): a code by email after a password. Offered after the app, with what it doesn't protect
 *  against said plainly. Turning it on or off takes an emailed code. */
function EmailTwoFactor({ account, onChanged }: { "account": Account; "onChanged": () => void }) {
	const api = useContext(Api) as AccountApi;
	const [sent, setSent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const turn = account.emailMfa === null ? "on" : "off";

	if (account.email === null) {
		return null;
	}

	return (
		<div class="wa-stack">
			<h3 class="wa-heading-m">Or: a code by email</h3>
			<wa-callout variant="neutral">
				A code by email after your password stops someone who has only your password. It doesn't stop someone who has your inbox: your inbox can reset your password too. An authenticator app, above, protects against both.
			</wa-callout>
			<p>{account.emailMfa === null ? "Off." : `On since ${new Date(account.emailMfa.enrolledAt).toLocaleDateString()}: after a password, we email you a code.`}{account.mfa !== null && account.emailMfa !== null ? " (With the authenticator app on, it's the app we ask for.)" : ""}</p>
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			{sent ? (
				<form
					class="wa-cluster wa-gap-s account-code-form"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setProblem(undefined);
						void postWithReason<{ "on": boolean }>(api.submit, "/account/mfa/email", { "turn": turn, "code": (event.currentTarget.elements.namedItem("code") as HTMLInputElement).value }).then((answer) => {
							setBusy(false);

							if ("reason" in answer) {
								setProblem(answer.reason);
							} else {
								setSent(false);
								onChanged();
							}
						});
					}}
				>
					<wa-input name="code" label={`The code we sent to ${account.email.address}`} autocomplete="one-time-code" required />
					<wa-button type="submit" loading={busy}>{turn === "on" ? "Turn on" : "Turn off"}</wa-button>
				</form>
			) : (
				<div>
					<wa-button
						loading={busy}
						onClick={() => {
							setBusy(true);
							setProblem(undefined);
							void postWithReason<{ "sent": boolean }>(api.submit, "/account/mfa/email/code", { "turn": turn }).then((answer) => {
								setBusy(false);

								if ("reason" in answer) {
									setProblem(answer.reason);
								} else {
									setSent(true);
								}
							});
						}}
					>
						{turn === "on" ? "Turn on: email me a code" : "Turn off: email me a code"}
					</wa-button>
				</div>
			)}
		</div>
	);
}

/** Your account, by `api`; `heading` off where the app titles it already (the editor's dialog). */
export function AccountPage({ api, heading = true }: { "api": AccountApi; "heading"?: boolean }) {
	const [account, setAccount] = useState<Account | undefined>();
	const [login, setLogin] = useState<string | undefined>();
	const [reads, setReads] = useState(0);

	useEffect(() => {
		void api.get<Account>("/account").then((answer) => {
			setAccount(answer);

			if (answer.githubId !== null) {
				void api.loginOf?.(answer.githubId).then(setLogin);
			}
		});
	}, [reads]);

	if (account === undefined) {
		return <wa-spinner />;
	}

	const row = (method: string, detail: string) => <tr key={method}><td>{method}</td><td>{detail}</td></tr>;

	return (
		<Api.Provider value={api}>
			<section class="wa-stack wa-gap-l">
				{heading && <h1 class="wa-heading-xl">Your account</h1>}
				<div class="table">
					<table class="wa-zebra-rows">
						<tbody>
							{row("GitHub", account.githubId === null ? "Not connected" : login ?? `GitHub user ${account.githubId}`)}
							{row("Email", account.email?.address ?? "None")}
							{row("Password", account.password === null ? "Not set" : `Set ${new Date(account.password.setAt).toLocaleDateString()}`)}
						{row("Passkeys", account.passkeys.length === 0 ? "None" : String(account.passkeys.length))}
							{row("Two-factor", [account.mfa === null ? undefined : `an authenticator app, ${account.mfa.recoveryLeft} recovery codes left`, account.emailMfa === null ? undefined : "a code by email after a password"].filter((part) => part !== undefined).join("; ") || "Off")}
						</tbody>
					</table>
				</div>
				{(account.githubId === null || account.email === null) && (
					<>
						<h2 class="wa-heading-l">Ways to sign in</h2>
						{account.githubId === null && (
							<ConnectGitHub
								onChanged={() => {
									setReads(reads + 1);
								}}
							/>
						)}
						{account.email === null && (
							<AddEmail
								onChanged={() => {
									setReads(reads + 1);
								}}
							/>
						)}
					</>
				)}
				<h2 class="wa-heading-l">Passkeys</h2>
				<Passkeys
					account={account}
					onChanged={() => {
						setReads(reads + 1);
					}}
				/>
				<h2 class="wa-heading-l">Two-factor</h2>
				<TwoFactor
					account={account}
					onChanged={() => {
						setReads(reads + 1);
					}}
				/>
				<EmailTwoFactor
					account={account}
					onChanged={() => {
						setReads(reads + 1);
					}}
				/>
				<h2 class="wa-heading-l">Password</h2>
				<SetPassword
					account={account}
					onSet={() => {
						setReads(reads + 1);
					}}
				/>
				<p class="account-mono account-muted">{account.user}</p>
			</section>
		</Api.Provider>
	);
}
