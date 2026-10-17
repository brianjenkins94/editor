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
		"wrong password": "That isn't the password."
	};

	return reasons[body.reason] ?? (body.error === "no_attempt" ? "This sign-in has expired or was opened somewhere else. Go back to the app and sign in again." : "Something went wrong. Try again.");
}

/** Sign in with a password: on a match, on to the app. */
async function signIn(address, password, button) {
	button.disabled = true;

	const { ok, body } = await post("/auth/password", { "address": address, "password": password });

	if (ok) {
		location.assign(body.location);

		return;
	}

	button.disabled = false;
	say(explain(body));
}

/** Check a code: on a match, on to the app. */
async function verify(code, button) {
	button.disabled = true;

	const { ok, body } = await post("/auth/email/verify", { "code": code });

	if (ok) {
		location.assign(body.location);

		return;
	}

	button.disabled = false;
	say(explain(body));
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
	const form = element("form", { "className": "stack" }, element("label", { "textContent": "Email" }, address), passwordLabel, codeButton, signInButton, toggle);

	toggle.addEventListener("click", () => {
		const usePassword = passwordLabel.hidden;

		passwordLabel.hidden = !usePassword;
		password.required = usePassword;
		codeButton.hidden = usePassword;
		signInButton.hidden = !usePassword;
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
		await verify(linked, button);
		methods.replaceChildren(...choices);
	}
} else if (linked !== null) {
	// The link, opened somewhere other than where the sign-in started: the code, to type there.
	intro.textContent = "";
	methods.replaceChildren(element("p", { "className": "note", "textContent": "Type this code on the sign-in page, in the browser where you started:" }), element("p", { "className": "code", "textContent": `${linked.slice(0, 4)}-${linked.slice(4)}` }));
} else {
	intro.textContent = "";
	say("This sign-in has expired or was opened somewhere else. Go back to the app and sign in again.");
}
