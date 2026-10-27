/**
 * A git remote reached through another realm: isomorphic-git's HTTP as messages. The workbench has the repository and
 * makes the requests (workbench/git-service.ts); the shell has the sign-in and sends them (shell/git-push.ts). A request
 * and its answer cross whole — bodies as bytes, never a credential.
 */
import type { HttpClient } from "isomorphic-git";

/** A request isomorphic-git makes, its body whole. */
export interface RemoteRequest { "url": string; "method": string; "headers": Record<string, string>; "body"?: Uint8Array }

/** Its answer, its body whole. */
export interface RemoteResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": Uint8Array }

/** isomorphic-git's HTTP client over `send`: each request's body gathered, sent, and its answer handed back. */
export function remoteHttp(send: (request: RemoteRequest) => Promise<RemoteResponse>): HttpClient {
	return {
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

			const answer = await send({ "url": url, "method": method, "headers": headers, ...sent.length === 0 ? {} : { "body": sent } });

			return { "url": url, "method": method, "statusCode": answer.status, "statusMessage": answer.statusText, "headers": answer.headers, "body": [answer.body][Symbol.iterator]() as unknown as AsyncIterableIterator<Uint8Array> };
		}
	};
}
