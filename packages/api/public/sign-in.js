// The sign-in page (README.md, "Sign-in methods"): what this browser's attempt may use (GET /auth/attempt). GitHub is a link on; email is
// a form for the address (POST /auth/email), then one for the code (POST /auth/email/verify), which answers with where
// to go: the app's page, with our code. A password (POST /auth/password) signs in with the same address, and answers
// the same way. The attempt itself is the cookie /auth/start set; nothing here holds anything.
//
// A passkey (POST /auth/passkey/options, then the passkey's answer to POST /auth/passkey) signs in on its own, and
// answers the same way.
//
// The email's link is this page with the code in its fragment (#code=…): in the browser that started, it's sent as if
// typed; anywhere else, there's no attempt here, and the page shows the code to type where the sign-in started.
// (Web Awesome's components, bundled beside this page: scripts/webawesome.ts — defined before anything here makes one)
import "/webawesome.js";
import { get as askPasskey, supported as passkeys } from "/webauthn.js";

const intro = document.querySelector("#for");
const methods = document.querySelector("#methods");
const problem = document.querySelector("#problem");

/** An element, with its properties and children. */
function element(tag, properties = {}, ...children) {
	const made = Object.assign(document.createElement(tag), properties);

	made.append(...children);

	return made;
}

function say(text) {
	problem.hidden = text === "";
	problem.textContent = text;
}

/** A form POST to the API, same-origin: its JSON, and whether it was ok. */
async function post(path, form) {
	const response = await fetch(path, { "method": "POST", "credentials": "same-origin", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(form) });

	return { "ok": response.ok, "body": await response.json().catch(() => ({})) };
}

/** What a refusal means, in words (src/email.ts's reasons). */
function explain(body) {
	const reasons = {
		"not an email address": "That isn't an email address.",
		"a code was sent less than a minute ago": "A code was sent less than a minute ago. Wait a moment, then ask again.",
		"five codes sent in the last hour": "Five codes have been sent to this address in the last hour. Try again later.",
		"not a code": "A code is 8 letters and digits, like ABCD-2345.",
		"code wrong": "That isn't the code we sent.",
		"code expired": "That code has expired. Ask for another.",
		"too many tries": "Too many tries. Wait a minute, then try again.",
		"no code sent": "Ask for a code first.",
		"email isn't set up here": "Email sign-in isn't available here yet.",
		"no account with that email": "There's no account with that email. Ask for a code instead: that makes one.",
		"that account has no password: sign in with a code": "That account has no password yet. Ask for a code instead.",
		"wrong password": "That isn't the password.",
		"ask for a code first": "Ask for a code first.",
		"couldn't check it against known breaches: try again": "We couldn't check that password against known breaches just now. Try again.",
		"that code isn't right, or it's been used": "That code isn't right, or it's been used. Wait for the app's next code.",
		"that recovery code isn't one of yours, or it's been used": "That recovery code isn't one of yours, or it's been used.",
		"two-factor code needed: from your authenticator app, or a recovery code": "This account has two-factor on: add a code from your authenticator app, or a recovery code.",
		"that passkey isn't one of ours: sign in another way": "That passkey isn't one of ours (it may have been removed). Sign in another way.",
		"that passkey couldn't be checked: try again": "That passkey couldn't be checked. Try again.",
		"ask the passkey again": "That took too long. Try the passkey again."
	};

	return reasons[body.reason] ?? (body.error === "no_attempt" ? "This sign-in has expired or was opened somewhere else. Go back to the app and sign in again." : "Something went wrong. Try again.");
}

/** The second step, for an account with two-factor on: a code from the authenticator app or a recovery code ("totp"),
 *  or the code just emailed ("email", after a password). */
function secondForm(kind) {
	const code = element("wa-input", { "label": "Code", "name": "code", "type": "text", "required": true, "autocomplete": "one-time-code", "spellcheck": false, "placeholder": kind === "email" ? "ABCD-2345" : "123456" });
	const submit = element("wa-button", { "type": "submit", "variant": "brand", "textContent": "Sign in" });
	const form = element("form", { "className": "wa-stack" }, element("p", { "textContent": kind === "email" ? "This account has two-factor by email on. We sent a code to your email: type it to finish signing in." : "This account has two-factor on. Type the code from your authenticator app, or one of your recovery codes." }), code, submit);

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		submit.disabled = true;

		const { ok, body } = await post("/auth/second", { "code": code.value });

		submit.disabled = false;

		if (ok) {
			location.assign(body.location);

			return;
		}

		say(explain(body));
	});

	return form;
}

/** Where a first factor's answer leads: on to the app, or to the second step. */
function onward(body) {
	if (body.second_factor !== undefined) {
		say("");
		methods.replaceChildren(secondForm(body.second_factor));
		methods.querySelector("wa-input").focus();

		return;
	}

	location.assign(body.location);
}

/** Sign in with a password: on a match, on to the app (or to the second step). */
async function signIn(address, password, button) {
	button.disabled = true;

	const { ok, body } = await post("/auth/password", { "address": address, "password": password });

	if (ok) {
		onward(body);

		return;
	}

	button.disabled = false;
	say(explain(body));
}

/** Check a code: on a match, on to the app (or to the second step). Whether it matched. */
async function verify(code, button) {
	button.disabled = true;

	const { ok, body } = await post("/auth/email/verify", { "code": code });

	if (ok) {
		onward(body);

		return true;
	}

	button.disabled = false;
	say(explain(body));

	return false;
}

/** The code's form, once one is sent to `address`. */
function codeForm(address) {
	const code = element("wa-input", { "label": "Code", "name": "code", "type": "text", "required": true, "autocomplete": "one-time-code", "autocapitalize": "characters", "spellcheck": false, "placeholder": "ABCD-2345" });
	const submit = element("wa-button", { "type": "submit", "variant": "brand", "textContent": "Sign in" });
	const again = element("wa-button", { "appearance": "outlined", "textContent": "Send another code" });
	const form = element("form", { "className": "wa-stack" }, element("p", { "textContent": `We sent a code to ${address}. It works for 10 minutes.` }), code, submit, again);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void verify(code.value, submit);
	});
	again.addEventListener("click", () => {
		void send(address, again);
	});

	return form;
}

/** Send a code to `address`, then ask for it. */
async function send(address, button) {
	button.disabled = true;

	const { ok, body } = await post("/auth/email", { "address": address });

	button.disabled = false;

	if (!ok) {
		say(explain(body));

		return;
	}

	say("");
	methods.replaceChildren(codeForm(address));
	methods.querySelector("wa-input").focus();
}

/** Resetting a forgotten password (C4): a code to the address, then the code and a new password, and whether to end
 *  every sign-in of the account. The attempt is spent: the app signs in again, with the new password. */
function resetForm(address) {
	const ask = element("wa-button", { "variant": "brand", "textContent": "Email me a reset code" });
	const code = element("wa-input", { "label": "Code", "name": "code", "type": "text", "autocomplete": "one-time-code", "autocapitalize": "characters", "spellcheck": false, "placeholder": "ABCD-2345" });
	const password = element("wa-input", { "label": "New password", "hint": "10 to 100 characters: letters, digits, spaces and the symbols on a US keyboard. Checked against known breaches.", "name": "password", "type": "password", "autocomplete": "new-password" });
	const end = element("wa-checkbox", { "checked": true, "textContent": "Also end every sign-in of this account, everywhere" });
	const second = element("wa-input", { "label": "Two-factor code, or a recovery code", "name": "second", "type": "text", "autocomplete": "one-time-code", "spellcheck": false, "placeholder": "Only if you've turned two-factor on" });
	const submit = element("wa-button", { "type": "submit", "variant": "brand", "textContent": "Reset my password" });
	const rest = element("div", { "className": "wa-stack", "hidden": true }, code, password, second, end, submit);
	const form = element("form", { "className": "wa-stack" }, element("p", { "textContent": `Reset the password for ${address}.` }), ask, rest);

	ask.addEventListener("click", async () => {
		ask.disabled = true;

		const { ok, body } = await post("/auth/reset", { "address": address });

		ask.disabled = false;

		if (!ok) {
			say(explain(body));

			return;
		}

		say("");
		ask.textContent = "Send another code";
		ask.variant = "neutral";
		ask.appearance = "outlined";
		rest.hidden = false;
		code.focus();
	});
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		submit.disabled = true;

		const { ok, body } = await post("/auth/reset/password", { "address": address, "code": code.value, "password": password.value, "second": second.value, "end": end.checked ? "true" : "" });

		submit.disabled = false;

		if (!ok) {
			say(explain(body));

			return;
		}

		say("");
		methods.replaceChildren(element("p", { "textContent": `Your password is reset${body.ended > 0 ? `, and ${body.ended} sign-in${body.ended === 1 ? "" : "s"} ended` : ""}. Go back to the app and sign in with it.` }));
	});

	return form;
}

/** Signing in with a passkey: a challenge for this attempt, the device's answer, and on to the app. */
async function passkeySignIn(button) {
	say("");
	button.disabled = true;

	try {
		const options = await post("/auth/passkey/options", {});

		if (!options.ok) {
			say(explain(options.body));

			return;
		}

		const { ok, body } = await post("/auth/passkey", { "credential": await askPasskey(options.body) });

		if (ok) {
			location.assign(body.location);

			return;
		}

		say(explain(body));
	} catch (error) {
		say(error?.name === "NotAllowedError" ? "No passkey was used. Try again, or sign in another way." : "This device couldn't use a passkey.");
	} finally {
		button.disabled = false;
	}
}

/** The address, then a code by email, or a password: whichever the attempt offers. With both, the code first, and the
 *  password a step away. */
function emailForm(offered) {
	const byEmail = offered.includes("email");
	const address = element("wa-input", { "label": "Email", "name": "address", "type": "email", "required": true, "autocomplete": "username email", "placeholder": "you@example.com" });
	const password = element("wa-input", { "label": "Password", "name": "password", "type": "password", "autocomplete": "current-password", "hidden": byEmail });
	const codeButton = element("wa-button", { "type": "submit", "variant": "brand", "textContent": "Email me a code", "hidden": !byEmail });
	const signInButton = element("wa-button", { "type": "submit", "variant": "brand", "textContent": "Sign in", "hidden": byEmail });
	const toggle = element("wa-button", { "appearance": "outlined", "textContent": "Use a password instead", "hidden": !(byEmail && offered.includes("password")) });
	const forgot = element("wa-button", { "appearance": "plain", "size": "s", "textContent": "Forgot your password?", "hidden": byEmail });
	const form = element("form", { "className": "wa-stack" }, address, password, codeButton, signInButton, toggle, forgot);

	forgot.addEventListener("click", () => {
		if (!address.reportValidity()) {
			return;
		}

		say("");
		methods.replaceChildren(resetForm(address.value));
	});

	toggle.addEventListener("click", () => {
		const usePassword = password.hidden;

		password.hidden = !usePassword;
		password.required = usePassword;
		codeButton.hidden = usePassword;
		signInButton.hidden = !usePassword;
		forgot.hidden = !usePassword;
		toggle.textContent = usePassword ? "Email me a code instead" : "Use a password instead";

		(usePassword ? password : address).focus();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		say("");
		void (password.hidden ? send(address.value, codeButton) : signIn(address.value, password.value, signInButton));
	});

	return form;
}

// The link's code, if this is the link: taken out of the address bar at once.
const linked = new URLSearchParams(location.hash.slice(1)).get("code");

if (linked !== null) {
	history.replaceState(null, "", location.pathname);
}

const response = await fetch("/auth/attempt", { "credentials": "same-origin" });

if (response.ok) {
	const { name, "methods": offered } = await response.json();
	const choices = [];

	intro.textContent = `to ${name}`;

	if (offered.includes("github")) {
		choices.push(element("wa-button", { "variant": "brand", "href": "/auth/github", "textContent": "Continue with GitHub" }));
	}

	if (offered.includes("passkey") && passkeys()) {
		const button = element("wa-button", { "variant": "brand", "textContent": "Sign in with a passkey" });

		button.addEventListener("click", () => {
			void passkeySignIn(button);
		});
		choices.push(button);
	}

	if (offered.includes("email") || offered.includes("password")) {
		if (choices.length > 0) {
			choices.push(element("p", { "className": "wa-caption-m wa-text-center", "textContent": "or" }));
		}

		choices.push(emailForm(offered));
	}

	methods.replaceChildren(...choices);

	if (linked !== null && offered.includes("email")) {
		const button = element("wa-button", { "variant": "brand", "textContent": "Signing in…", "disabled": true });

		// On a match the page moves on to the app; otherwise, the reason, and the choices again.
		methods.replaceChildren(button);
		if (!await verify(linked, button)) {
			methods.replaceChildren(...choices);
		}
	}
} else if (linked !== null) {
	// The link, opened somewhere other than where the sign-in started: the code, to type there.
	intro.textContent = "";
	methods.replaceChildren(element("p", { "textContent": "Type this code on the sign-in page, in the browser where you started:" }), element("p", { "className": "wa-heading-2xl wa-text-center" }, element("code", { "textContent": `${linked.slice(0, 4)}-${linked.slice(4)}` })));
} else {
	intro.textContent = "";
	say("This sign-in has expired or was opened somewhere else. Go back to the app and sign in again.");
}
