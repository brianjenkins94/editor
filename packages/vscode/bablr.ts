/**
 * The editor's BABLR, from the workbench realm: one worker (bablr-worker.ts), asked one call at a time, behind a cache of
 * what it derives. BABLR is a VM interpreter — about 14ms a line — so it never runs on the UI thread, and nothing is
 * derived twice: a text's spans and a change's verdict are pure functions of their content, so they're kept by git blob
 * oid in `.silo/local/bablr/` (on this machine, never committed — silo's `local/`), and a hit skips BABLR entirely:
 *
 *   spans/<oid>.json            a text's spans (each span's spanAnchors id and offsets), or that BABLR can't parse it
 *   verdicts/<oid>_<oid>.json   a change's cosmetic/semantic verdict (cosmetic-classifier.ts)
 *
 * Everything there can be deleted at any time; it's capped at CACHE_BYTES (small: it shares the workspace's fixed
 * buffer), least recently used first out.
 *
 * Its callers: the cosmetic classifier (verdicts, edit groups), the runtime evidence (evidence.ts: span ids for a run's
 * statements), and — over the hub, `spans.of` — the pod's `editor.bablr.spans` command, for extensions (the insights
 * extension's evidence marks). One worker for now; if BABLR's cost outgrows it, a pool goes here, behind `request`.
 *
 * ABORT: the worker yields between parse chunks, so a cancelled call's signal reaches it mid-run and it bails
 * cooperatively (the worker stays warm); a still-queued call is dropped unsent. A worker that fails to load, or dies,
 * fails what's in flight and every later call.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { VerdictStore } from "./cosmetic-classifier";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/evidence";
import { fs } from "@zenfs/core";
import { blobOid } from "./git-engine";

/** One span of a text: its spanAnchors id and offsets (punctuation left out — it's never a handle). */
export interface Span { "id": string; "start": number; "end": number }

export interface Bablr {
	/** Ask the worker for `bablr.<name>` (bablr-worker.ts), after whatever was asked before. No timeout: the first call
	 *  waits out the worker's (large) bundle loading, and a parse takes what it takes; `signal` and a dead worker end it. */
	"request": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T>;
	/** `source`'s spans — cached by its blob oid — or undefined when BABLR's grammar doesn't take it. */
	"spans": (source: string, signal?: AbortSignal) => Promise<Span[] | undefined>;
	/** The span id standing for each of `ranges` in `source` (bablr-language-ts's pickAnchor), from its cached spans. */
	"anchors": (source: string, ranges: { "start": number; "end": number }[]) => Promise<(string | undefined)[] | undefined>;
	/** The verdict cache, for the cosmetic classifier. */
	"verdicts": VerdictStore;
	"dispose": () => void;
}

const CACHE = `/workspace/${LOCAL_DIR}/bablr`;
/** How much the cache keeps before it lets the least recently used go. Small: `/workspace` is one fixed 64 MB buffer the
 *  whole project shares (workspace-fs.ts), and this lives in it — until the cache moves to its own IndexedDB store. */
const CACHE_BYTES = 4 * 1024 * 1024;
/** How many writes between checks of the cache's size (a text's spans can be ~100 KB). */
const PRUNE_EVERY = 5;

export function startBablr(hub: Hub): Bablr {
	const worker = new Worker(new URL("./lsp/bablr-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	const rpc = createRpcClient(hub);
	const dead = new AbortController();

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		dead.abort(new Error("BABLR worker failed: " + (event.message || "could not load")));
	});

	// One call at a time: BABLR is slow, and the newest request is the one someone is waiting on.
	let tail: Promise<unknown> = Promise.resolve();

	const request = <T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> => {
		const combined = signal === undefined ? dead.signal : AbortSignal.any([signal, dead.signal]);
		// An already-aborted signal skips the call unsent.
		const run = tail.then(() => rpc.request("bablr." + name, args, { "timeoutMs": Infinity, "waitForResponderMs": 30000, "signal": combined }) as Promise<T>);

		tail = run.catch(() => undefined);

		// Reject a queued call as soon as it's aborted, not when its turn comes.
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => { reject(combined.reason); };

			combined.addEventListener("abort", onAbort, { "once": true });
			run.then(resolve, reject).finally(() => { combined.removeEventListener("abort", onAbort); });
		});
	};

	// ── the cache ──
	let writes = 0;

	const read = async <T>(file: string): Promise<T | undefined> => {
		try {
			const value = JSON.parse(new TextDecoder().decode(await fs.promises.readFile(file))) as T;
			const now = new Date();

			void fs.promises.utimes(file, now, now).catch(() => undefined); // recently used: last out

			return value;
		} catch {
			return undefined; // a miss (or unreadable): derive it again
		}
	};

	/** Let the least recently used go once the cache passes CACHE_BYTES, down to three quarters of it. */
	const prune = async (): Promise<void> => {
		const entries: { "file": string; "size": number; "used": number }[] = [];

		for (const dir of ["spans", "verdicts"]) {
			for (const name of await fs.promises.readdir(`${CACHE}/${dir}`).catch(() => [] as string[])) {
				const file = `${CACHE}/${dir}/${name}`;
				const stats = await fs.promises.stat(file).catch(() => undefined);

				if (stats !== undefined) {
					entries.push({ "file": file, "size": stats.size, "used": stats.mtimeMs });
				}
			}
		}

		let total = entries.reduce((sum, entry) => sum + entry.size, 0);

		if (total <= CACHE_BYTES) {
			return;
		}

		for (const entry of entries.sort((a, b) => a.used - b.used)) {
			if (total <= CACHE_BYTES * 0.75) {
				break;
			}

			await fs.promises.unlink(entry.file).catch(() => undefined);
			total -= entry.size;
		}
	};

	const write = async (dir: string, name: string, value: unknown): Promise<void> => {
		try {
			await fs.promises.mkdir(`${CACHE}/${dir}`, { "recursive": true });
			await fs.promises.writeFile(`${CACHE}/${dir}/${name}`, JSON.stringify(value));

			writes += 1;

			if (writes % PRUNE_EVERY === 0) {
				await prune();
			}
		} catch { /* nowhere to keep it: it's derived again next time */ }
	};

	// The verdict cache used to live in `.git/bablr/`; it's all derivable, so it just goes.
	void fs.promises.rm("/workspace/.git/bablr", { "recursive": true, "force": true }).catch(() => undefined);

	const spans = async (source: string, signal?: AbortSignal): Promise<Span[] | undefined> => {
		if (source === "") {
			return undefined; // BABLR has nothing to parse
		}

		const oid = await blobOid(source);
		const file = `${CACHE}/spans/${oid}.json`;
		const cached = await read<{ "spans"?: Span[]; "unparsable"?: true }>(file);

		if (cached !== undefined) {
			return cached.spans;
		}

		const derived = await request<{ "spans"?: Span[]; "unparsable"?: true }>("spans", { "source": source }, signal);

		await write("spans", `${oid}.json`, derived);

		return derived.spans;
	};

	// The pod's `editor.bablr.spans` (for extensions) asks here, so it gets the cache too.
	const offServe = serve(hub, "spans.of", async (args, { signal }) => {
		const source = (args as { "source"?: unknown } | undefined)?.source;

		return typeof source === "string" ? { "spans": await spans(source, signal) } : {};
	});

	return {
		"request": request,
		"spans": spans,
		"anchors": async (source, ranges) => {
			const known = await spans(source);

			if (known === undefined) {
				return undefined;
			}

			const { ids } = await request<{ "ids": (string | null)[] }>("pick", { "spans": known, "ranges": ranges });

			return ids.map((id) => id ?? undefined);
		},
		"verdicts": {
			"read": async (before, after) => (await read(`${CACHE}/verdicts/${await blobOid(before)}_${await blobOid(after)}.json`)) ?? null,
			"write": async (before, after, entry) => { await write("verdicts", `${await blobOid(before)}_${await blobOid(after)}.json`, entry); }
		},
		"dispose": () => {
			offServe();
			unlink();
			worker.terminate();
		}
	};
}
