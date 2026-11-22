// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "node:buffer";
import { fs, InMemory } from "@zenfs/core";
import type { HttpClient } from "isomorphic-git";
import { clone, currentBranch } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { API, dpopFetch } from "./session";

// eslint-disable-next-line ts/naming-convention -- the `Buffer` global isomorphic-git reads
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

export const CORS_PROXY = "https://cors.isomorphic-git.org";

const MOUNT = "/clone";

export interface ClonedRepo {
	"branch": string;
	"files": { "path": string; "bytes": Uint8Array }[];
}

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
