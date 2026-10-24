/**
 * How a program's gated call goes by the policy — the one rule tsval's interpreter (debug-worker.ts) and the runtime's
 * files (runtime-fs.ts, any debugger's) both decide by: skipped where the policy skips it; in a live run (retyping
 * mustn't touch the world) nothing made but a read the policy allows; otherwise made if allowed, else refused. Pure.
 */
import type { Policy, Trigger } from "@brianjenkins94/util/silo/policy";
import { effectiveDisposition, isDangerous } from "@brianjenkins94/util/silo/policy";

export type Verdict = "allow" | "skip" | "deny";

/** Who started a run, as a rule matches it (`trigger`): a live run is the editor's, after an edit; any other, yours. */
export const triggerOf = (live: boolean): Trigger => (live ? "edit" : "you");

export function verdictOf(policy: Policy | undefined, capability: string, resource: string, live = false): Verdict {
	const disposition = policy === undefined ? undefined : effectiveDisposition(policy, capability, resource, isDangerous(capability), { "trigger": triggerOf(live) });

	if (disposition === "skip" || (live && !(disposition === "allow" && capability === "fs:read"))) {
		return "skip";
	}

	return disposition === "allow" ? "allow" : "deny";
}

/** What of a request a recording is told apart by beyond its URL (RUNNING.md, *Open*: "Matching a recording"): its
 *  method and a hash of its body, as `POST #1a2b3c4d` — none for a GET or HEAD without a body, so a read's recording keys
 *  as it always has. Only `net` calls (fetch's `(url, init)` or a Request) have one. */
export function requestOf(capability: string, args: unknown[]): string | undefined {
	if (capability !== "net") {
		return undefined;
	}

	const [input, init] = args as [unknown, { "method"?: unknown; "body"?: unknown } | undefined];
	const from = typeof input === "object" && input !== null && "method" in input ? input as { "method"?: unknown } : undefined;
	const method = String(init?.method ?? from?.method ?? "GET").toUpperCase();
	const body = bodyText(init?.body);

	if ((method === "GET" || method === "HEAD") && body === undefined) {
		return undefined;
	}

	return body === undefined ? method : `${method} #${fnv1a(body)}`;
}

/** A request body as text, to hash: a string, URL-encoded parameters, or bytes — undefined for none. */
function bodyText(body: unknown): string | undefined {
	if (body === undefined || body === null) {
		return undefined;
	}

	if (typeof body === "string") {
		return body;
	}

	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);

		return String.fromCharCode(...bytes);
	}

	return String(body);
}

/** FNV-1a, 32 bits, as hex: a short, stable hash of a body. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;

	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return hash.toString(16).padStart(8, "0");
}

/** A recording's key: `<capability> <resource>`, and its request when it has one (requestOf). */
export const recordingKey = (capability: string, resource: string, request?: string): string => `${capability} ${resource}${request === undefined ? "" : " " + request}`;

/** Whether the policy itself skips the call (a rule's *then skip*), as opposed to a live run skipping what it can't make. */
export function policySkips(policy: Policy | undefined, capability: string, resource: string, live = false): boolean {
	return policy !== undefined && effectiveDisposition(policy, capability, resource, isDangerous(capability), { "trigger": triggerOf(live) }) === "skip";
}
