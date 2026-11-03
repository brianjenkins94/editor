/**
 * The editor's BABLR, off the main thread (workbench/bablr.ts starts it and asks one thing at a time): whether BABLR's
 * grammar takes a text, and why not when it doesn't — `bablr.parse` { source } → { parsed, why?, ms, cached }. BABLR is
 * a VM interpreter, about 14 ms a line, so a text's answer is kept by its git blob oid in this browser's IndexedDB
 * (`bablr`, its own database, not the workspace's store), under PARSE_VERSION, so a grammar change asks again: a file
 * is parsed once however often it's asked about.
 *
 * What's built on a parse — spans, annotations, verdicts (`full-editor`'s worker) — comes back with the features that
 * need it. A parse yields as it goes, so a cancelled call's signal ends it mid-parse and the worker stays.
 */
import "./bablr-fast-freeze"; // first: neutralizes record freezing before the BABLR bundle captures Object.freeze
// (A comment, so sorting leaves the freeze first.)
import { cstSpansAsync, PARSE_VERSION } from "@brianjenkins94/bablr";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { NETWORK_PROBES } from "../shared/architecture";

const hub = createHub({ "id": "bablr" });

hub.link(portTransport(globalThis));

const { log } = observe(hub, { "network": NETWORK_PROBES });

/** A text's answer as kept: whether it parsed, why not, and what the parse took. */
interface Answer { "parsed": boolean; "why"?: string; "ms": number }

/** A text's git blob oid: what git calls the same content. */
async function blobOid(text: string): Promise<string> {
	const body = new TextEncoder().encode(text);
	const header = new TextEncoder().encode(`blob ${String(body.length)}\0`);
	const bytes = new Uint8Array(header.length + body.length);

	bytes.set(header);
	bytes.set(body, header.length);

	return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => {
			resolve(request.result);
		});
		request.addEventListener("error", () => {
			reject(request.error ?? new Error("IndexedDB failed"));
		});
	});
}

/** The answers, kept: a store of them by PARSE_VERSION and blob oid; another version's go as it opens. */
const database = new Promise<IDBDatabase | undefined>((resolve) => {
	try {
		const open = indexedDB.open("bablr", 2);

		open.addEventListener("upgradeneeded", () => {
			// (full-editor's kept spans too, a version before: they go)
			for (const name of [...open.result.objectStoreNames]) {
				open.result.deleteObjectStore(name);
			}

			open.result.createObjectStore("parses");
		});
		open.addEventListener("success", () => {
			resolve(open.result);
		});
		open.addEventListener("error", () => {
			resolve(undefined);
		});
	} catch {
		resolve(undefined); // no IndexedDB here: parsed every time
	}
}).then(async (db) => {
	if (db !== undefined) {
		const parses = db.transaction("parses", "readwrite").objectStore("parses");

		for (const key of await done(parses.getAllKeys()) as string[]) {
			if (!key.startsWith(PARSE_VERSION + "/")) {
				parses.delete(key);
			}
		}
	}

	return db;
}).catch(() => undefined);

serve(hub, "bablr.parse", async (args, { signal }) => {
	const { source } = (args ?? {}) as { "source"?: unknown };

	if (typeof source !== "string") {
		throw new TypeError("bablr.parse takes { source }");
	}

	const key = PARSE_VERSION + "/" + await blobOid(source);
	const db = await database;
	const kept = db === undefined ? undefined : await done(db.transaction("parses").objectStore("parses").get(key) as IDBRequest<Answer | undefined>).catch(() => undefined);

	if (kept !== undefined) {
		return { ...kept, "cached": true };
	}

	const answer = await log.span("editor.workers.bablr-worker.parse", { "bytes": source.length }, async (span): Promise<Answer> => {
		const started = performance.now();

		try {
			await cstSpansAsync(source, "Program", { "signal": signal });
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			span.end({ "parsed": false });

			return { "parsed": false, "why": error instanceof Error ? error.message : String(error), "ms": Math.round(performance.now() - started) };
		}

		span.end({ "parsed": true });

		return { "parsed": true, "ms": Math.round(performance.now() - started) };
	});

	if (db !== undefined) {
		await done(db.transaction("parses", "readwrite").objectStore("parses").put(answer, key)).catch(() => undefined);
	}

	return { ...answer, "cached": false };
});
