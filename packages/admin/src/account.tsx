/**
 * Your account (README.md; packages/api/SIGN-IN.md, C3): how you sign in (GitHub, your email, a password), and setting or
 * changing your password: a code to your email first (the action's own check), then the password. Anyone signed in to
 * the admin app has one, roles or none: the No access card links here too.
 */
import { useEffect, useState } from "preact/hooks";
import { loginOf } from "./logins";
import { get, submit } from "./session";

interface Account { "user": string; "githubId": number | null; "email": { "address": string; "verifiedAt": number | null } | null; "password": { "setAt": number } | null }

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
					</tbody>
				</table>
			</div>
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
