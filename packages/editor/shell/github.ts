import type { AuthProvider } from "./github-auth";
import { withDefaults } from "@brianjenkins94/util/fido";
import { API as SESSION_API, dpopFetch, viaProxy } from "./session";

const API = "https://api.github.com";

const PROXY = `${SESSION_API}/github/api`;

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
	"type": string;
	"sha": string;
	"size"?: number;
}

function jsonBody(payload: unknown): { "headers": Record<string, string>; "body": string } {
	return { "headers": { "Content-Type": "application/json" }, "body": JSON.stringify(payload) };
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64.replace(/\n/gu, ""));

	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function decodeBase64ToText(base64: string): string {
	return new TextDecoder().decode(base64ToBytes(base64));
}

export interface RepoFile {
	"path": string;
	"bytes": Uint8Array;
}

export function createGitHub(provider: AuthProvider = fetch, base: string = API) {
	const sanitized: AuthProvider = (input, init = {}) => {
		const headers = new Headers(init.headers);

		headers.delete("Cache");
		headers.delete("cache");

		return provider(String(input instanceof Request ? input.url : input).replace(API, base), { ...init, "headers": headers });
	};

	const gh = withDefaults(API, {
		"fetch": sanitized,
		"debug": false,
		"headers": {
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28"
		}
	});

	async function run<T>(pending: Promise<Response>, read: (response: Response) => Promise<unknown> = async (response) => response.json()): Promise<T> {
		let response: Response;

		try {
			response = await pending;
		} catch (error) {
			const failure = (error as { "response"?: { "status": number; "statusText": string; "body": unknown } }).response;

			if (failure !== undefined) {
				throw new GitHubError(failure.status, failure.statusText, failure.body);
			}

			throw error;
		}

		if (!response.ok) {
			const body = await response.json().catch(() => undefined);

			throw new GitHubError(response.status, response.statusText, body);
		}

		return (response.status === 204 ? undefined : await read(response)) as T;
	}

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
		"raw": gh,

		"viewer": function(): Promise<{ "login": string }> {
			return run(gh.get("/user"));
		},

		"getRepo": function(owner: string, repo: string): Promise<Repo | undefined> {
			return optional(gh.get("/repos/" + owner + "/" + repo));
		},

		"createRepo": function(name: string, options: { "private"?: boolean; "description"?: string; "autoInit"?: boolean } = {}): Promise<Repo> {
			return run(gh.post("/user/repos", jsonBody({
				"name": name,
				"private": options.private ?? false,
				"description": options.description,
				"auto_init": options.autoInit ?? true
			})));
		},

		"readTree": function(owner: string, repo: string, ref = "HEAD"): Promise<{ "sha": string; "tree": TreeEntry[]; "truncated": boolean }> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/git/trees/" + ref, { "recursive": 1 }));
		},

		"readBlob": function(owner: string, repo: string, sha: string): Promise<{ "content": string; "encoding": string; "size": number }> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/git/blobs/" + sha));
		},

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

		// eslint-disable-next-line ts/naming-convention -- GitHub's wire fields
		"runs": function(owner: string, repo: string, options: { "commit"?: string; "branch"?: string; "limit"?: number } = {}): Promise<{ "total_count": number; "workflow_runs": Record<string, unknown>[] }> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/actions/runs", {
				...options.commit === undefined ? {} : { "head_sha": options.commit },
				...options.branch === undefined ? {} : { "branch": options.branch },
				"per_page": options.limit ?? 20
			}));
		},

		// eslint-disable-next-line ts/naming-convention -- GitHub's wire fields
		"runJobs": function(owner: string, repo: string, runId: number, attempts = false): Promise<{ "total_count": number; "jobs": Record<string, unknown>[] }> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/actions/runs/" + String(runId) + "/jobs", { "per_page": 100, ...attempts ? { "filter": "all" } : {} }));
		},

		"jobLog": function(owner: string, repo: string, jobId: number): Promise<string> {
			return run(gh.get("/repos/" + owner + "/" + repo + "/actions/jobs/" + String(jobId) + "/logs"), async (response) => response.text());
		},

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

export async function connectGitHub(): Promise<GitHub> {
	return await viaProxy() ? createGitHub(dpopFetch, PROXY) : createGitHub();
}

export async function actions(request: unknown): Promise<unknown> {
	const { repository, commit, branch, run, attempts, job, limit } = (request ?? {}) as { "repository"?: unknown; "commit"?: unknown; "branch"?: unknown; "run"?: unknown; "attempts"?: unknown; "job"?: unknown; "limit"?: unknown };
	const [owner, repo, ...more] = typeof repository === "string" ? repository.split("/") : [];

	if (owner === undefined || repo === undefined || more.length > 0) {
		throw new TypeError("github.actions takes { repository: \"owner/repo\", commit?, branch?, run?, attempts?, job? }");
	}

	const signedIn = await viaProxy();
	const gh = await connectGitHub();

	try {
		if (typeof job === "number") {
			return { "signedIn": signedIn, "log": await gh.jobLog(owner, repo, job) };
		}

		if (typeof run === "number") {
			return { "signedIn": signedIn, ...await gh.runJobs(owner, repo, run, attempts === true) };
		}

		return { "signedIn": signedIn, ...await gh.runs(owner, repo, { ...typeof commit === "string" ? { "commit": commit } : {}, ...typeof branch === "string" ? { "branch": branch } : {}, ...typeof limit === "number" ? { "limit": limit } : {} }) };
	} catch (error) {
		if (error instanceof GitHubError) {
			return { "signedIn": signedIn, "refused": { "status": error.status, "message": error.message } };
		}

		throw error;
	}
}
