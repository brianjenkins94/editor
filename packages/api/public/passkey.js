// Adding a passkey (SIGN-IN.md, "Passkeys"), on the API's own origin: passkeys belong to its host, so they're made here,
// not on the app's page. The app sent the browser here with a ticket and the registration's options in the fragment
// (taken out of the address bar at once); the passkey made, POST /passkey/register checks it and answers with the app's
// page to go back to, where the app finishes adding it.
import { create, supported } from "/webauthn.js";

const steps = document.querySelector("#steps");
const problem = document.querySelector("#problem");
const given = new URLSearchParams(location.hash.slice(1));
const ticket = given.get("ticket");
const options = given.get("options");

history.replaceState(null, "", location.pathname);

function say(text) {
	problem.hidden = text === "";
	problem.textContent = text;
}

// eslint-disable-next-line webawesome/prefer-components -- the sign-in pages are plain HTML and their own CSS: nothing runs here but our own files
const button = Object.assign(document.createElement("button"), { "type": "button", "className": "method", "textContent": "Create a passkey" });
const note = Object.assign(document.createElement("p"), { "className": "note", "textContent": "Your device asks for your fingerprint, face or PIN, or offers your password manager. The passkey stays there: we keep only its public key." });

button.addEventListener("click", async () => {
	say("");
	button.disabled = true;

	try {
		const credential = await create(JSON.parse(options));
		const response = await fetch("/passkey/register", { "method": "POST", "credentials": "same-origin", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "ticket": ticket, "credential": credential }) });
		const body = await response.json().catch(() => ({}));

		if (response.ok) {
			location.assign(body.location);

			return;
		}

		say(body.reason === undefined ? "Something went wrong. Try again." : `${body.reason[0].toUpperCase()}${body.reason.slice(1)}.`);
	} catch (error) {
		say(error?.name === "NotAllowedError" ? "No passkey was made. Try again, or go back to the app." : error?.name === "InvalidStateError" ? "This device already has a passkey for your account." : "This device couldn't make a passkey.");
	}

	button.disabled = false;
});

if (ticket === null || options === null) {
	say("This page has expired. Go back to the app and add the passkey again.");
} else if (!supported()) {
	say("This browser can't make passkeys.");
} else {
	steps.replaceChildren(note, button);
}
