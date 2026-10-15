/**
 * Load a GitHub repo by CLONING it — isomorphic-git, shallow (depth 1, one branch) — rather than fetching its blobs one
 * request at a time through the API (230 files took 2.5 minutes behind fido's 100-a-minute limiter). One pack, so a
 * repo loads in seconds.
 *
 * A browser can't reach github.com's git endpoints directly (they send no CORS headers). Signed in, the clone goes through
 * the API's proxy (packages/api/src/proxy.ts), every request with our DPoP-bound token: GitHub's token is added there and
 * never reaches the browser. Signed out, a public repo clones through isomorphic-git's public proxy,
 * cors.isomorphic-git.org, with no credential at all.
 *
 * The clone lands in memory, in a zen-fs mount of its own in the SHELL's realm (never the workspace's FS — that's the
 * app's: the token stays here), and ALL of it is returned — its working tree and its `.git` — for the shell to publish
 * to the app as a repo load always has. The workspace becomes the clone, history and all: the editor's source control,
 * changes and edit history read a real repo, its HEAD the commit cloned.
 */
// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "node:buffer";
import { fs, InMemory } from "@zenfs/core";
import type { HttpClient } from "isomorphic-git";
import { clone, currentBranch } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { API, dpopFetch } from "./session";

// isomorphic-git reads the `Buffer` global (a Node-ism); see git-engine.ts.
// eslint-disable-next-line ts/naming-convention -- the `Buffer` global isomorphic-git reads
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

/** isomorphic-git's public CORS proxy for github.com. */
export const CORS_PROXY = "https://cors.isomorphic-git.org";

const MOUNT = "/clone";

export interface ClonedRepo {
	/** The branch the clone checked out (the repo's default). */
	"branch": string;
	/** Every file, repo-relative, as bytes (binary round-trips) — the working tree and `.git/` (a shallow clone's: one
	 *  pack, its index, the refs, the git index). */
	"files": { "path": string; "bytes": Uint8Array }[];
}

/** isomorphic-git's HTTP client over `dpopFetch`: each request carries our token and a proof (a clone is two requests). */
const signedInHttp: HttpClient = {
	"request": async ({ url, method = "GET", headers = {}, body }) => {
		const chunks: Uint8Array[] = [];

		for await (const chunk of body ?? []) {
			chunks.push(chunk);
		}

		const sent = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));

		chunks.reduce((offset, chunk) => {
			sent.set(chunk, offset);

			return offset + chunk.length;
		}, 0);

		const response = await dpopFetch(url, { "method": method, "headers": headers, ...sent.length === 0 ? {} : { "body": sent } });
		const received = new Uint8Array(await response.arrayBuffer());

		return {
			"url": url,
			"method": method,
			"statusCode": response.status,
			"statusMessage": response.statusText,
			"headers": Object.fromEntries(response.headers),
			"body": (async function* () {
				yield received;
			})()
		};
	}
};

/** Shallow-clone `owner/repo` into memory and return its files, `.git` included: through the API's proxy when signed in
 *  (any repo the sign-in can see), through the public proxy when not (public repos only). */
export async function cloneRepo(owner: string, repo: string, signedIn: boolean): Promise<ClonedRepo> {
	const dir = MOUNT + "/" + owner + "-" + repo;

	fs.mount(MOUNT, InMemory.create({ "label": "clone" }));

	try {
		await clone({
			"fs": fs,
			"dir": dir,
			...signedIn
				? { "http": signedInHttp, "url": `${API}/github/git/${owner}/${repo}.git` }
				: { "http": http, "url": "https://github.com/" + owner + "/" + repo + ".git", "corsProxy": CORS_PROXY },
			"singleBranch": true,
			"depth": 1
		});

		const files: ClonedRepo["files"] = [];
		const walk = async (at: string, rel: string): Promise<void> => {
			for (const name of await fs.promises.readdir(at)) {
				const full = at + "/" + name;
				const path = rel === "" ? name : rel + "/" + name;

				if ((await fs.promises.stat(full)).isDirectory()) {
					await walk(full, path);
				} else {
					files.push({ "path": path, "bytes": new Uint8Array(await fs.promises.readFile(full)) });
				}
			}
		};

		await walk(dir, "");

		return { "branch": (await currentBranch({ "fs": fs, "dir": dir })) || "main", "files": files };
	} finally {
		fs.umount(MOUNT);
	}
}
