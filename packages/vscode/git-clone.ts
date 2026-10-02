/**
 * Load a GitHub repo by CLONING it — isomorphic-git, shallow (depth 1, one branch) — rather than fetching its blobs one
 * request at a time through the API (230 files took 2.5 minutes behind fido's 100-a-minute limiter). One pack, so a
 * repo loads in seconds.
 *
 * A browser can't reach github.com's git endpoints directly (they send no CORS headers), so the clone goes through
 * isomorphic-git's public proxy, cors.isomorphic-git.org — and when it's authenticated, the PAT goes with it: the proxy
 * relays the request, so its operator could read the token. Accepted for now (2026-10-02): the PAT is retired once
 * login with GitHub lands, and a proxy of our own (the workbench plan's Cloudflare Worker) is the way back to the
 * token reaching only GitHub.
 *
 * The clone lands in memory, in a zen-fs mount of its own in the SHELL's realm (never the workspace's FS — that's the
 * app's), and its working tree is returned for the shell to publish to the app as a repo load always has.
 */
// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "buffer";
import { fs, InMemory } from "@zenfs/core";
import { clone, currentBranch } from "isomorphic-git";
import http from "isomorphic-git/http/web";

// isomorphic-git reads the `Buffer` global (a Node-ism); see git-engine.ts.
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

/** isomorphic-git's public CORS proxy for github.com. */
export const CORS_PROXY = "https://cors.isomorphic-git.org";

const MOUNT = "/clone";

export interface ClonedRepo {
	/** The branch the clone checked out (the repo's default). */
	"branch": string;
	/** Every working-tree file, repo-relative, as bytes (binary round-trips). */
	"files": { "path": string; "bytes": Uint8Array }[];
}

/** Shallow-clone `owner/repo` into memory and return its working tree. `token`, when given, authenticates the clone
 *  (through the proxy — see above); without one, only a public repo clones. */
export async function cloneRepo(owner: string, repo: string, token?: string): Promise<ClonedRepo> {
	const dir = MOUNT + "/" + owner + "-" + repo;

	fs.mount(MOUNT, InMemory.create({ "label": "clone" }));

	try {
		await clone({
			"fs": fs,
			"http": http,
			"dir": dir,
			"url": "https://github.com/" + owner + "/" + repo + ".git",
			"corsProxy": CORS_PROXY,
			"singleBranch": true,
			"depth": 1,
			...token === undefined ? {} : { "onAuth": () => ({ "username": token }) }
		});

		const files: ClonedRepo["files"] = [];
		const walk = async (at: string, rel: string): Promise<void> => {
			for (const name of await fs.promises.readdir(at)) {
				if (rel === "" && name === ".git") {
					continue;
				}

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
