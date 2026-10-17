/**
 * A GitHub stand-in for the harness, so signing in works locally with no secret: its authorize page asks who to sign
 * in as (you, the owner in OWNERS, or someone new), and it answers the calls the API makes of GitHub (the code
 * exchange, a refresh, /user, an authorization revoked) as GitHub would. Used when `.dev.vars` has no
 * GITHUB_CLIENT_SECRET; with one, the harness talks to the real GitHub through the dev GitHub App.
 */
import { createServer } from "node:http";

/** Who the stand-in signs in as: GitHub user ids and logins. */
export interface Person { "id": number; "login": string }

/** Start it on `port`; its origin is what the API's GITHUB_ORIGIN and GITHUB_API point at. */
export function githubStandIn(port: number, owner: Person): Promise<string> {
	const people = new Map<string, Person>(); // code or token → who it's for
	const issue = (person: Person): Record<string, unknown> => {
		const token = { "access_token": `ghu_standin_${crypto.randomUUID()}`, "refresh_token": `ghr_standin_${crypto.randomUUID()}`, "expires_in": 28800, "refresh_token_expires_in": 15897600, "token_type": "bearer" };

		people.set(token.access_token, person).set(token.refresh_token, person);

		return token;
	};
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://localhost:${port}`);
		let body = "";

		request.on("data", (chunk) => {
			body += chunk;
		}).on("end", () => {
			// GitHub's authorize page: a choice of who to be, each a link back to the API's callback with a code.
			if (url.pathname === "/login/oauth/authorize") {
				const back = (person: Person): string => {
					const code = `code_${crypto.randomUUID()}`;
					const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

					people.set(code, person);
					callback.search = new URLSearchParams({ "code": code, "state": url.searchParams.get("state") ?? "" }).toString();

					return callback.href;
				};
				const someone = { "id": 1_000_000 + Math.floor(Math.random() * 1e9), "login": `someone-${Math.floor(Math.random() * 1e4)}` };

				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(`<!doctype html><meta charset="utf-8"><title>GitHub stand-in</title>
<style>body{font:15px system-ui;display:grid;place-items:center;min-height:100vh;margin:0}main{display:grid;gap:10px;max-width:26rem}a{padding:10px 14px;border:1px solid #888;border-radius:8px;text-decoration:none}</style>
<main><h1>GitHub stand-in</h1><p>The harness's GitHub (no client secret in .dev.vars). Sign in as:</p>
<a href="${back(owner)}">${owner.login} (${owner.id}): the owner</a>
<a href="${back(someone)}">${someone.login} (${someone.id}): someone else</a>
<a href="${url.searchParams.get("redirect_uri")}?error=access_denied&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}">Cancel</a></main>`);

				return;
			}

			response.setHeader("content-type", "application/json");

			// The code exchange and a refresh: tokens for whoever the code or refresh token was for.
			if (url.pathname === "/login/oauth/access_token") {
				const form = new URLSearchParams(body);
				const person = people.get(form.get("code") ?? form.get("refresh_token") ?? "");

				response.end(JSON.stringify(person === undefined ? { "error": "bad_verification_code" } : issue(person)));

				return;
			}

			const person = people.get((request.headers.authorization ?? "").replace(/^(?:Bearer|token) /u, ""));

			if (url.pathname === "/user" && person !== undefined) {
				response.end(JSON.stringify({ "id": person.id, "login": person.login }));

				return;
			}

			// An authorization or token revoked (sign out, account deletion): done.
			if (request.method === "DELETE" && url.pathname.startsWith("/applications/")) {
				response.statusCode = 204;
				response.end();

				return;
			}

			response.statusCode = 404;
			response.end(JSON.stringify({ "message": "Not Found (the harness's GitHub stand-in answers sign-in only)" }));
		});
	});

	return new Promise((resolve) => {
		server.listen(port, () => {
			resolve(`http://localhost:${port}`);
		});
	});
}
