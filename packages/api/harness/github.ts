/**
 * A GitHub stand-in for the harness, so signing in works locally with no secret: its authorize page asks who to sign
 * in as (you, the owner in OWNERS, or someone new), and it answers the calls the API makes of GitHub (the code
 * exchange, a refresh, /user, an authorization revoked) as GitHub would. Used when `.dev.vars` has no
 * GITHUB_CLIENT_SECRET; with one, the harness talks to the real GitHub through the dev GitHub App.
 *
 * Given a folder of bare repositories (`<owner>/<repo>.git`), it serves them as GitHub does what the editor asks of it
 * (through the API's proxy, src/proxy.ts): git over HTTP — a clone, a fetch, a push — by git's own `http-backend`, and
 * the REST calls a load makes (a repository, its tree, a blob). Anyone may read and push: they're the test's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "@brianjenkins94/util/fs";
import { escapeHtml } from "@brianjenkins94/util/text";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import * as path from "node:path";

/** Who the stand-in signs in as: GitHub user ids and logins. */
export interface Person { "id": number; "login": string }

const GIT = /^\/[\w.-]+\/[\w.-]+?\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/u;
const REST = /^\/repos\/([\w.-]+)\/([\w.-]+)(?:\/git\/(trees|blobs)\/([\w./-]+))?$/u;

/** git over HTTP for `repositories`' bare repositories: `git http-backend`, its CGI answer relayed. */
function serveGit(repositories: string, request: IncomingMessage, url: URL, body: Buffer, response: ServerResponse): void {
	const backend = spawn("git", ["http-backend"], {
		"env": {
			...process.env,
			"GIT_PROJECT_ROOT": repositories,
			"GIT_HTTP_EXPORT_ALL": "1",
			// (someone, so a push is taken: http-backend refuses an anonymous receive-pack)
			"REMOTE_USER": "stand-in",
			"PATH_INFO": url.pathname,
			"REQUEST_METHOD": request.method ?? "GET",
			"QUERY_STRING": url.search.slice(1),
			"CONTENT_TYPE": request.headers["content-type"] ?? "",
			"HTTP_CONTENT_ENCODING": request.headers["content-encoding"] ?? "",
			"GIT_PROTOCOL": String(request.headers["git-protocol"] ?? "")
		}
	});
	const out: Buffer[] = [];

	backend.stdout.on("data", (chunk: Buffer) => out.push(chunk));
	backend.on("close", () => {
		const answer = Buffer.concat(out);
		const split = answer.indexOf("\r\n\r\n");
		const headers = answer.subarray(0, split).toString("utf-8").split("\r\n");

		for (const line of headers) {
			const [name, ...value] = line.split(": ");

			if (name.toLowerCase() === "status") {
				response.statusCode = Number.parseInt(value.join(": "), 10);
			} else {
				response.setHeader(name, value.join(": "));
			}
		}

		response.end(answer.subarray(split + 4));
	});
	backend.stdin.end(body);
}

/** The REST calls a load makes of a repository: itself, its tree (recursive), a blob. */
function serveRest(repositories: string, match: RegExpExecArray, response: ServerResponse): void {
	const [, owner, repo, kind, ref] = match;
	const folder = path.join(repositories, owner, `${repo}.git`);
	const git = (...args: string[]): string => execFileSync("git", args, { "cwd": folder, "encoding": "utf-8", "maxBuffer": 64 * 1024 * 1024 });

	if (!fs.existsSync(folder)) {
		response.statusCode = 404;
		response.end(JSON.stringify({ "message": "Not Found" }));

		return;
	}

	const branch = git("symbolic-ref", "--short", "HEAD").trim();

	if (kind === undefined) {
		response.end(JSON.stringify({ "name": repo, "full_name": `${owner}/${repo}`, "owner": { "login": owner }, "private": false, "default_branch": branch, "permissions": { "admin": true, "push": true, "pull": true } }));
	} else if (kind === "trees") {
		const tree = git("ls-tree", "-r", "-t", "-l", ref).trim().split("\n").filter((line) => line !== "").map((line) => {
			const [meta, file] = line.split("\t");
			const [mode, type, sha, size] = meta.split(/\s+/u);

			return { "path": file, "mode": mode, "type": type, "sha": sha, ...type === "blob" ? { "size": Number(size) } : {} };
		});

		response.end(JSON.stringify({ "sha": git("rev-parse", `${ref}^{tree}`).trim(), "tree": tree, "truncated": false }));
	} else {
		const bytes = Buffer.from(execFileSync("git", ["cat-file", "blob", ref], { "cwd": folder, "maxBuffer": 64 * 1024 * 1024 }));

		response.end(JSON.stringify({ "sha": ref, "size": bytes.length, "encoding": "base64", "content": bytes.toString("base64") }));
	}
}

/**
 * Start it on `port`; its origin is what the API's GITHUB_ORIGIN and GITHUB_API point at. With `repositories`, a folder
 * of `<owner>/<repo>.git` bare repositories, it serves those too.
 */
export function githubStandIn(port: number, owner: Person, repositories?: string): Promise<string> {
	const people = new Map<string, Person>(); // code or token → who it's for
	const issue = (person: Person): Record<string, unknown> => {
		const token = { "access_token": `ghu_standin_${crypto.randomUUID()}`, "refresh_token": `ghr_standin_${crypto.randomUUID()}`, "expires_in": 28800, "refresh_token_expires_in": 15897600, "token_type": "bearer" };

		people.set(token.access_token, person).set(token.refresh_token, person);

		return token;
	};
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://localhost:${port}`);
		const chunks: Buffer[] = [];

		request.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		}).on("end", () => {
			const raw = Buffer.concat(chunks);
			const body = raw.toString("utf-8");

			if (repositories !== undefined && GIT.test(url.pathname)) {
				serveGit(repositories, request, url, raw, response);

				return;
			}

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

			const rest = repositories === undefined ? null : REST.exec(url.pathname);

			if (rest !== null && repositories !== undefined) {
				serveRest(repositories, rest, response);

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
			response.end(JSON.stringify({ "message": "Not Found (the harness's GitHub stand-in answers sign-in, and its repositories' git and REST calls)" }));
		});
	});

	// (what keeps the process up is whoever started it: the harness's own server, a test's run)
	server.unref();

	return new Promise((resolve) => {
		server.listen(port, () => {
			resolve(`http://localhost:${port}`);
		});
	});
}
