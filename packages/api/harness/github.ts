/**
 * A GitHub stand-in for the harness, so signing in works locally with no secret: its authorize page asks who to sign
 * in as (you, the owner in OWNERS, or someone new), and it answers the calls the API makes of GitHub (the code
 * exchange, a refresh, /user, an authorization revoked) as GitHub would. Used when `.dev.vars` has no
 * GITHUB_CLIENT_SECRET; with one, the harness talks to the real GitHub through the dev GitHub App.
 */
import * as fs from "@brianjenkins94/util/fs";
import { escapeHtml } from "@brianjenkins94/util/text";
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

				const cancel = new URL(url.searchParams.get("redirect_uri") ?? "");

				cancel.search = new URLSearchParams({ "error": "access_denied", "state": url.searchParams.get("state") ?? "" }).toString();

				// github.html, its {{placeholders}} filled (HTML-escaped; they're ours, but a login could be anything).
				const fill: Record<string, string> = { "owner.href": back(owner), "owner.login": owner.login, "owner.id": String(owner.id), "someone.href": back(someone), "someone.login": someone.login, "someone.id": String(someone.id), "cancel.href": cancel.href };

				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(fs.readFileSync(new URL("github.html", import.meta.url).pathname, { "encoding": "utf-8" }).replace(/\{\{([\w.]+)\}\}/gu, (_, key: string) => escapeHtml(fill[key] ?? "")));

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
