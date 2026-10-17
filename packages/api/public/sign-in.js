// The sign-in page (SIGN-IN.md): what this browser's attempt may use (GET /auth/attempt), as buttons. The attempt itself
// is the cookie /auth/start set; nothing here holds anything.
const NAMES = { "admin": "the admin app", "editor": "the editor" };
const LABELS = { "github": "Continue with GitHub" };
const PATHS = { "github": "/auth/github" };

const response = await fetch("/auth/attempt", { "credentials": "same-origin" });
const intro = document.querySelector("#for");

if (response.ok) {
	const { client, methods } = await response.json();

	intro.textContent = `to ${NAMES[client] ?? client}`;
	document.querySelector("#methods").append(...methods.filter((method) => method in PATHS).map((method) => Object.assign(document.createElement("a"), { "className": "method", "href": PATHS[method], "textContent": LABELS[method] })));
} else {
	intro.textContent = "";

	const problem = document.querySelector("#problem");

	problem.hidden = false;
	problem.textContent = "This sign-in has expired or was opened somewhere else. Go back to the app and sign in again.";
}
