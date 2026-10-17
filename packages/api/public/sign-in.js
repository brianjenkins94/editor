// The sign-in page (SIGN-IN.md): what this browser's attempt may use (GET /auth/attempt). GitHub is a link on; email is
// a form for the address (POST /auth/email), then one for the code (POST /auth/email/verify), which answers with where
// to go: the app's page, with our code. A password (POST /auth/password) signs in with the same address, and answers
// the same way. The attempt itself is the cookie /auth/start set; nothing here holds anything.
//
// The email's link is this page with the code in its fragment (#code=…): in the browser that started, it's sent as if
// typed; anywhere else, there's no attempt here, and the page shows the code to type where the sign-in started.
const NAMES = { "admin": "the admin app", "editor": "the editor" };

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
		"two-factor code needed: from your authenticator app, or a recovery code": "This account has two-factor on: add a code from your authenticator app, or a recovery code."
	};

	return reasons[body.reason] ?? (body.error === "no_attempt" ? "This sign-in has expired or was opened somewhere else. Go back to the app and sign in again." : "Something went wrong. Try again.");
}

/** The second step, for an account with two-factor on: a code from the authenticator app, or a recovery code. */
function secondForm() {
	const code = element("input", { "name": "code", "type": "text", "required": true, "autocomplete": "one-time-code", "spellcheck": false, "placeholder": "123456" });
	const submit = element("button", { "type": "submit", "className": "method", "textContent": "Sign in" });
	const form = element("form", { "className": "stack" },
		element("p", { "className": "note", "textContent": "This account has two-factor on. Type the code from your authenticator app, or one of your recovery codes." }),
		element("label", { "textContent": "Code" }, code),
		submit);

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
	if (body.second_factor === true) {
		say("");
		methods.replaceChildren(secondForm());
		methods.querySelector("input").focus();

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
	const code = element("input", { "name": "code", "type": "text", "required": true, "autocomplete": "one-time-code", "autocapitalize": "characters", "spellcheck": false, "placeholder": "ABCD-2345" });
	const submit = element("button", { "type": "submit", "className": "method", "textContent": "Sign in" });
	const again = element("button", { "type": "button", "className": "secondary", "textContent": "Send another code" });
	const form = element("form", { "className": "stack" }, element("p", { "className": "note", "textContent": `We sent a code to ${address}. It works for 10 minutes.` }), element("label", { "textContent": "Code" }, code), submit, again);

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
	methods.querySelector("input").focus();
}

/** Resetting a forgotten password (C4): a code to the address, then the code and a new password, and whether to end
 *  every sign-in of the account. The attempt is spent: the app signs in again, with the new password. */
function resetForm(address) {
	const ask = element("button", { "type": "button", "className": "method", "textContent": "Email me a reset code" });
	const code = element("input", { "name": "code", "type": "text", "autocomplete": "one-time-code", "autocapitalize": "characters", "spellcheck": false, "placeholder": "ABCD-2345" });
	const password = element("input", { "name": "password", "type": "password", "autocomplete": "new-password" });
	const end = element("input", { "type": "checkbox", "checked": true });
	const second = element("input", { "name": "second", "type": "text", "autocomplete": "one-time-code", "spellcheck": false, "placeholder": "Only if you've turned two-factor on" });
	const submit = element("button", { "type": "submit", "className": "method", "textContent": "Reset my password" });
	const rest = element("div", { "className": "stack", "hidden": true },
		element("label", { "textContent": "Code" }, code),
		element("label", { "textContent": "New password" }, password),
		element("p", { "className": "note", "textContent": "10 to 100 characters: letters, digits, spaces and the symbols on a US keyboard. Checked against known breaches." }),
		element("label", { "textContent": "Two-factor code, or a recovery code" }, second),
		element("label", { "className": "check" }, end, "Also end every sign-in of this account, everywhere"),
		submit);
	const form = element("form", { "className": "stack" }, element("p", { "className": "note", "textContent": `Reset the password for ${address}.` }), ask, rest);

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
		ask.className = "secondary";
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
		methods.replaceChildren(element("p", { "className": "note", "textContent": `Your password is reset${body.ended > 0 ? `, and ${body.ended} sign-in${body.ended === 1 ? "" : "s"} ended` : ""}. Go back to the app and sign in with it.` }));
	});

	return form;
}

/** The address, then a code by email, or a password: whichever the attempt offers. With both, the code first, and the
 *  password a step away. */
function emailForm(offered) {
	const byEmail = offered.includes("email");
	const address = element("input", { "name": "address", "type": "email", "required": true, "autocomplete": "username email", "placeholder": "you@example.com" });
	const password = element("input", { "name": "password", "type": "password", "autocomplete": "current-password" });
	const passwordLabel = element("label", { "textContent": "Password", "hidden": byEmail }, password);
	const codeButton = element("button", { "type": "submit", "className": "method", "textContent": "Email me a code", "hidden": !byEmail });
	const signInButton = element("button", { "type": "submit", "className": "method", "textContent": "Sign in", "hidden": byEmail });
	const toggle = element("button", { "type": "button", "className": "secondary", "textContent": "Use a password instead", "hidden": !(byEmail && offered.includes("password")) });
	const forgot = element("button", { "type": "button", "className": "link", "textContent": "Forgot your password?", "hidden": byEmail });
	const form = element("form", { "className": "stack" }, element("label", { "textContent": "Email" }, address), passwordLabel, codeButton, signInButton, toggle, forgot);

	forgot.addEventListener("click", () => {
		if (!address.reportValidity()) {
			return;
		}

		say("");
		methods.replaceChildren(resetForm(address.value));
	});

	toggle.addEventListener("click", () => {
		const usePassword = passwordLabel.hidden;

		passwordLabel.hidden = !usePassword;
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
		void (passwordLabel.hidden ? send(address.value, codeButton) : signIn(address.value, password.value, signInButton));
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
	const { client, "methods": offered } = await response.json();
	const choices = [];

	intro.textContent = `to ${NAMES[client] ?? client}`;

	if (offered.includes("github")) {
		choices.push(element("a", { "className": "method", "href": "/auth/github", "textContent": "Continue with GitHub" }));
	}

	if (offered.includes("email") || offered.includes("password")) {
		if (choices.length > 0) {
			choices.push(element("p", { "className": "or", "textContent": "or" }));
		}

		choices.push(emailForm(offered));
	}

	methods.replaceChildren(...choices);

	if (linked !== null && offered.includes("email")) {
		const button = element("button", { "type": "button", "className": "method", "textContent": "Signing in…", "disabled": true });

		// On a match the page moves on to the app; otherwise, the reason, and the choices again.
		methods.replaceChildren(button);
		if (!await verify(linked, button)) {
			methods.replaceChildren(...choices);
		}
	}
} else if (linked !== null) {
	// The link, opened somewhere other than where the sign-in started: the code, to type there.
	intro.textContent = "";
	methods.replaceChildren(element("p", { "className": "note", "textContent": "Type this code on the sign-in page, in the browser where you started:" }), element("p", { "className": "code", "textContent": `${linked.slice(0, 4)}-${linked.slice(4)}` }));
} else {
	intro.textContent = "";
	say("This sign-in has expired or was opened somewhere else. Go back to the app and sign in again.");
}
