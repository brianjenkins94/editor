/**
 * Your account (README.md; packages/api/SIGN-IN.md, C3): how you sign in (GitHub, your email, a password), and setting or
 * changing your password: a code to your email first (the action's own check), then the password. Anyone signed in to
 * the admin app has one, roles or none: the No access card links here too.
 */
import { useEffect, useState } from "preact/hooks";
import { renderSVG } from "uqr";
import { loginOf } from "./logins";
import { get, submit } from "./session";

interface Account { "user": string; "githubId": number | null; "email": { "address": string; "verifiedAt": number | null } | null; "password": { "setAt": number } | null; "mfa": { "enrolledAt": number; "recoveryLeft": number } | null }

/** What a refusal's reason means, in words (packages/api/src/password.ts and email.ts say it plainly already; these few
 *  read better for a person). */
const WORDS: Record<string, string> = {
	"password: code wrong": "That isn't the code we sent.",
	"code wrong": "That isn't the code we sent.",
	"code expired": "That code has expired. Ask for another.",
	"too many tries": "Too many tries. Wait a minute, then try again.",
	"a code was sent less than a minute ago": "A code was sent less than a minute ago. Wait a moment, then ask again."
};

/** A form POST: its body, or what's wrong with it, in words. */
async function postWithReason<T>(path: string, form: Record<string, string>): Promise<{ "ok": true; "body": Partial<T> } | { "ok": false; "reason": string }> {
	try {
		const answer = await submit<T>(path, form);

		if (answer.ok) {
			return { "ok": true, "body": answer.body };
		}

		const reason = answer.body.reason ?? "";

		return { "ok": false, "reason": WORDS[reason] ?? (reason === "" ? "That didn't work. Try again." : `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}.`) };
	} catch {
		return { "ok": false, "reason": "Couldn't reach the API." };
	}
}

function SetPassword({ account, onSet }: { "account": Account; "onSet": () => void }) {
	const [sent, setSent] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const [done, setDone] = useState(false);

	if (account.email === null) {
		return <p class="muted">A password signs in with your email, and this account has none yet (it signs in with GitHub).</p>;
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
							void postWithReason<{ "address": string }>("/account/password/code", {}).then((answer) => {
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
				void postWithReason<{ "set": boolean }>("/account/password", { "code": field("code"), "password": field("password") }).then((answer) => {
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
			<p class="muted">We sent a code to {sent}. It works for 10 minutes.</p>
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
				<div class="mono recovery">{codes.map((code) => <span key={code}>{code}</span>)}</div>
			</div>
		</wa-callout>
	);
}

/** Two-factor (C5): set it up (the app scans a QR code, then a code confirms it), or, when it's on, new recovery codes or
 *  turn it off, each with a code. Each needs a sign-in in the last 10 minutes: the API says so if not. */
function TwoFactor({ account, onChanged }: { "account": Account; "onChanged": () => void }) {
	const [setup, setSetup] = useState<{ "secret": string; "uri": string } | undefined>();
	const [codes, setCodes] = useState<string[] | undefined>();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const call = async <T,>(path: string, form: Record<string, string>, then: (body: Partial<T>) => void): Promise<void> => {
		setBusy(true);
		setProblem(undefined);

		const answer = await postWithReason<T>(path, form);

		setBusy(false);

		if ("reason" in answer) {
			setProblem(answer.reason);
		} else {
			then(answer.body);
		}
	};
	const withCode = (label: string, action: string, path: string, then: (body: Partial<{ "recoveryCodes": string[] }>) => void) => (
		<form
			class="wa-cluster wa-gap-s code-form"
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
					<img class="qr" alt="QR code for your authenticator app" src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.uri, { "border": 2 }))}`} />
					<p class="muted">Or enter this key by hand: <span class="mono">{setup.secret.replaceAll(/(.{4})/gu, "$1 ").trim()}</span></p>
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

export function AccountPage() {
	const [account, setAccount] = useState<Account | undefined>();
	const [login, setLogin] = useState<string | undefined>();
	const [reads, setReads] = useState(0);

	useEffect(() => {
		void get<Account>("/account").then((answer) => {
			setAccount(answer);

			if (answer.githubId !== null) {
				void loginOf(answer.githubId).then(setLogin);
			}
		});
	}, [reads]);

	if (account === undefined) {
		return <wa-spinner />;
	}

	const row = (method: string, detail: string) => <tr key={method}><td>{method}</td><td>{detail}</td></tr>;

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Your account</h1>
			<div class="table">
				<table class="wa-zebra-rows">
					<tbody>
						{row("GitHub", account.githubId === null ? "Not connected" : login ?? `GitHub user ${account.githubId}`)}
						{row("Email", account.email?.address ?? "None")}
						{row("Password", account.password === null ? "Not set" : `Set ${new Date(account.password.setAt).toLocaleDateString()}`)}
						{row("Two-factor", account.mfa === null ? "Off" : `On: an authenticator app, ${account.mfa.recoveryLeft} recovery codes left`)}
					</tbody>
				</table>
			</div>
			<h2 class="wa-heading-l">Two-factor</h2>
			<TwoFactor
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
			<p class="mono muted">{account.user}</p>
		</section>
	);
}
