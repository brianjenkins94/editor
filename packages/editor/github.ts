/**
 * The GitHub data plane — the whole browser↔GitHub surface, built on `fido` and an {@link AuthProvider}.
 *
 * Runs SHELL-side (the only context that holds the token). GitHub's REST API is CORS-clean, so a static site on
 * localhost calls `api.github.com` directly — no proxy, no server. Writes go through the Git Data API (blobs →
 * tree → commit → move ref), NOT git-over-HTTP (which GitHub blocks from browsers).
 *
 * `fido` is already GitHub-shaped: its `backoff` honors `Rate-Limit-Reset`/`-After` (GitHub throttling) and its
 * `poll` follows RFC 5988 `Link: rel=next` (GitHub pagination) — so this module only layers auth + typed calls on
 * top. The client is constructed with `debug: false` so fido never touches its node-only debug path (`util.inspect`
 * / `process.env.NODE_ENV`), which keeps it bundling cleanly in the browser.
 *
 * The App swap changes exactly one thing here: the `provider` passed in. Everything below is auth-agnostic.
 */
import type { AuthProvider } from "./github-auth";
import { withDefaults } from "@brianjenkins94/util/fido";
import { patProvider } from "./github-auth";

const API = "https://api.github.com";

/** A GitHub API error carrying the status + parsed body, whether fido threw it (retried GET) or we did (4xx). */
export class GitHubError extends Error {
	public readonly status: number;
	public readonly body: unknown;

	public constructor(status: number, statusText: string, body: unknown) {
		const message = body !== null && typeof body === "object" && "message" in body ? body.message : undefined;
		const detail = typeof message === "string" ? message : statusText;

		super("GitHub " + status + ": " + detail);

		this.name = "GitHubError";
		this.status = status;
		this.body = body;
	}
}

/* eslint-disable ts/naming-convention -- these mirror GitHub REST wire fields verbatim */
export interface Repo {
	"name": string;
	"full_name": string;
	"owner": { "login": string };
	"default_branch": string;
	"private": boolean;
	"html_url": string;
}
/* eslint-enable ts/naming-convention */

export interface TreeEntry {
	"path": string;
	"mode": string;
	/** "blob" (file) or "tree" (directory). */
	"type": string;
	"sha": string;
	"size"?: number;
}

/** A file to write. Text goes inline into the tree; binary (`base64`) is uploaded as a blob first. */
export interface FileWrite {
	"path": string;
	"content"?: string;
	"base64"?: string;
	/** Git file mode; defaults to a normal file (100644). Use 100755 for an executable. */
	"mode"?: string;
}

export interface CommitOptions {
	"branch": string;
	"message": string;
	"files": FileWrite[];
	/** Force-move the ref (non-fast-forward). Off by default. */
	"force"?: boolean;
}

/** `Content-Type` + JSON body, in the shape fido's post/patch/put expect as their options argument. */
function jsonBody(payload: unknown): { "headers": Record<string, string>; "body": string } {
	return { "headers": { "Content-Type": "application/json" }, "body": JSON.stringify(payload) };
}

/** Decode a base64 blob (GitHub wraps it at 60 cols) to raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64.replace(/\n/gu, ""));

	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Encode raw bytes to base64 (for committing a binary file as a blob). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

/** Decode a base64 blob to UTF-8 text. */
export function decodeBase64ToText(base64: string): string {
	return new TextDecoder().decode(base64ToBytes(base64));
}

/** One file read from a repo — raw bytes so text and binary (sprites, etc.) both round-trip. */
export interface RepoFile {
	"path": string;
	"bytes": Uint8Array;
}

/**
 * Build the GitHub client. `provider` is the auth seam — defaults to the pasted-PAT provider; pass the App's
 * provider later without changing anything below.
 */
export function createGitHub(provider: AuthProvider = patProvider()) {
	// fido injects its own `Cache: no-store` directive into the request HEADERS. A non-safelisted header forces a CORS
	// preflight that GitHub rejects ("Failed to fetch"). fido reads that directive from the options before calling
	// fetch, so stripping it here (at the fetch boundary) leaves fido's caching intact while keeping the wire request
	// CORS-simple. Wrapping the passed-in provider covers both the PAT path and the future App (badgateway) provider.
	const sanitized: AuthProvider = (input, init = {}) => {
		const headers = new Headers(init.headers);

		headers.delete("Cache");
		headers.delete("cache");

		return provider(input, { ...init, "headers": headers });
	};

	const gh = withDefaults(API, {
		"fetch": sanitized,
		"debug": false,
		"headers": {
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28"
		}
	});

	/** Await a fido call and normalize both outcomes (thrown retried-GET error, or a resolved !ok response). */
	async function run<T>(pending: Promise<Response>): Promise<T> {
		let response: Response;

		try {
			response = await pending;
		} catch (error) {
			// fido throws on a retried GET failure, with the parsed body on error.response.
			const failure = (error as { "response"?: { "status": number; "statusText": string; "body": unknown } }).response;

			if (failure !== undefined) {
				throw new GitHubError(failure.status, failure.statusText, failure.body);
			}

			throw error; // a genuine network/transport failure
		}

		if (!response.ok) {
			const body = await response.json().catch(() => undefined);

			throw new GitHubError(response.status, response.statusText, body);
		}

		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	/** Like `run`, but a 404 resolves to undefined (for existence checks) instead of throwing. */
	async function optional<T>(pending: Promise<Response>): Promise<T | undefined> {
		try {
			return await run<T>(pending);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) {
				return undefined;
			}

			throw error;
		}
	}

	return {
		/** The client, exposed for one-off calls not wrapped below (already authed + GitHub-shaped). */
		"raw": gh,

		/** The authenticated user — also the cheapest token-validity check (401 ⇒ bad token). */
		"viewer": function(): Promise<{ "login": string }> {
			return run(gh.get("/user"));
		},

		/** A repo, or undefined if it doesn't exist / isn't visible to this token. */
		"getRepo": function(owner: string, repo: string): Promise<Repo | undefined> {
			return optional(gh.get("/repos/" + owner + "/" + repo));
		},

		/** Create a repo for the authenticated user. `autoInit` gives it an initial commit so it has a branch to write to. */
		"createRepo": function(name: string, options: { "private"?: boolean; "description"?: string; "autoInit"?: boolean } = {}): Promise<Repo> {
			return run(gh.post("/user/repos", jsonBody({
				"name": name,
				"private": options.private ?? false,
				"description": options.description,
				"auto_init": options.autoInit ?? true
			})));
		},

		/**
		 * The whole repo at a ref, as a flat path list (recursive). Entries carry blob shas; contents are fetched
		 * lazily via {@link readBlob}. `truncated` is true for very large repos (>100k entries / 7MB) — handle by
		 * walking sub-trees if it ever matters.
		 */
		"readTree": function(owner: string, repo: string, ref = "HEAD"): Promise<{ "sha": string; "tree": TreeEntry[]; "truncated": boolean }> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/git/trees/" + ref, { "recursive": 1 }));
		},

		/** A blob's content (base64 + encoding). Use {@link decodeBase64ToText} for text; keep the base64 for binary. */
		"readBlob": function(owner: string, repo: string, sha: string): Promise<{ "content": string; "encoding": string; "size": number }> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/git/blobs/" + sha));
		},

		/**
		 * Read the WHOLE repo at a ref into a flat list of files (raw bytes, so binary round-trips). The recursive tree
		 * gives every blob; each is fetched by sha (fido's limiter throttles the fan-out). Fine for game-sized repos;
		 * a big repo would want the tarball endpoint instead (one request) — a later optimization.
		 */
		"readRepo": async function(owner: string, repo: string, ref = "HEAD"): Promise<RepoFile[]> {
			const base = "/repos/" + owner + "/" + repo;
			const tree = await run<{ "tree": TreeEntry[]; "truncated": boolean }>(gh.get(base + "/git/trees/" + ref, { "recursive": 1 }));
			const blobs = tree.tree.filter((entry) => entry.type === "blob");

			return Promise.all(blobs.map(async (entry) => {
				const blob = await run<{ "content": string; "encoding": string }>(gh.get(base + "/git/blobs/" + entry.sha));
				const bytes = blob.encoding === "base64" ? base64ToBytes(blob.content) : new TextEncoder().encode(blob.content);

				return { "path": entry.path, "bytes": bytes };
			}));
		},

		/**
		 * Commit a set of files to a branch via the Git Data API and move the ref: read the branch tip, build a new
		 * tree over the base tree (text inline, binary as uploaded blobs), create the commit, then update the ref.
		 * Returns the new commit sha.
		 */
		"commitFiles": async function(owner: string, repo: string, options: CommitOptions): Promise<string> {
			const ref = "heads/" + options.branch;
			const base = "/repos/" + owner + "/" + repo;

			// 1. current tip of the branch → its tree
			const head = await run<{ "object": { "sha": string } }>(gh.get(base + "/git/ref/" + ref));
			const baseSha = head.object.sha;
			const baseCommit = await run<{ "tree": { "sha": string } }>(gh.get(base + "/git/commits/" + baseSha));

			// 2. tree entries — inline text; upload binary as blobs and reference their sha
			const tree = await Promise.all(options.files.map(async (file) => {
				const entry = { "path": file.path, "mode": file.mode ?? "100644", "type": "blob" as const };

				if (file.base64 !== undefined) {
					const blob = await run<{ "sha": string }>(gh.post(base + "/git/blobs", jsonBody({ "content": file.base64, "encoding": "base64" })));

					return { ...entry, "sha": blob.sha };
				}

				return { ...entry, "content": file.content ?? "" };
			}));

			// 3. new tree → commit → move the ref
			const newTree = await run<{ "sha": string }>(gh.post(base + "/git/trees", jsonBody({ "base_tree": baseCommit.tree.sha, "tree": tree })));
			const commit = await run<{ "sha": string }>(gh.post(base + "/git/commits", jsonBody({ "message": options.message, "tree": newTree.sha, "parents": [baseSha] })));

			await run(gh.patch(base + "/git/refs/" + ref, jsonBody({ "sha": commit.sha, "force": options.force ?? false })));

			return commit.sha;
		},

		/**
		 * Enable GitHub Pages, built by Actions (the model here: the repo's own pages.yml deploys `docs/`). A 409
		 * means Pages is already on — treated as success.
		 */
		"enablePages": async function(owner: string, repo: string): Promise<void> {
			try {
				await run(gh.post("/repos/" + owner + "/" + repo + "/pages", jsonBody({ "build_type": "workflow" })));
			} catch (error) {
				if (!(error instanceof GitHubError && error.status === 409)) {
					throw error;
				}
			}
		}
	};
}

export type GitHub = ReturnType<typeof createGitHub>;
