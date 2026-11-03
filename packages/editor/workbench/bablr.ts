/**
 * The editor's BABLR, from the workbench realm: one worker (bablr-worker.ts), asked one call at a time. BABLR is a VM
 * interpreter — about 14ms a line — so it never runs on the UI thread, and nothing is parsed twice: the worker keeps each
 * text's parse by its blob oid in its own IndexedDB cache, and everything it derives — spans, verdicts — starts
 * from that.
 *
 * Its callers: the review's verdicts (git-review.ts: cosmetic or semantic, and the nodes that changed), and the spans of
 * a text a test's trace is checked against (test-runs.ts: whether it ran code the file no longer has). One worker for now;
 * if BABLR's cost outgrows it, a pool goes here, behind `request`. A text BABLR can't parse throws Unparsable (why).
 *
 * ABORT: the worker yields between parse chunks, so a cancelled call's signal reaches it mid-run and it bails
 * cooperatively (the worker stays warm); a still-queued call is dropped unsent. A worker that fails to load, or dies,
 * fails what's in flight and every later call.
 */
import type { ChangeVerdict } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { createRpcClient, portTransport } from "@brianjenkins94/hub";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/layout";
import { fs } from "@zenfs/core";

/** BABLR's grammar doesn't take a text: `message` is why. */
export class Unparsable extends Error {
	public override readonly name = "Unparsable";
}

/** One span of a text: its spanAnchors id and offsets (punctuation left out — it's never a handle). */
export interface Span { "id": string; "start": number; "end": number }

export interface Bablr {
	/** Ask the worker for `bablr.<name>` (bablr-worker.ts), after whatever was asked before. No timeout: the first call
	 *  waits out the worker's (large) bundle loading, and a parse takes what it takes; `signal` and a dead worker end it. */
	"request": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T>;
	/** `source`'s spans — from its cached parse; none for an empty text. Throws Unparsable when BABLR's grammar doesn't
	 *  take it. */
	"spans": (source: string, signal?: AbortSignal) => Promise<Span[]>;
	/** What a change from `before` to `after` is (the worker's `verdict`, from its cached parses): cosmetic or semantic,
	 *  the nodes that changed and their lines in `after` — the session's answers kept, by the two texts. */
	"classify": (before: string, after: string, signal?: AbortSignal) => Promise<ChangeVerdict>;
	"dispose": () => void;
}

/** FNV-1a 32-bit — a cheap key for the session's verdicts. */
function fnv32(text: string): number {
	let hash = 0x811C9DC5;

	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return hash >>> 0;
}

export function startBablr(hub: Hub): Bablr {
	const worker = new Worker(new URL("./lsp/bablr-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	const rpc = createRpcClient(hub);
	const dead = new AbortController();

	watchWorker(worker, "bablr-worker", (message) => {
		dead.abort(new Error("BABLR worker failed: " + message));
	});

	// One call at a time: BABLR is slow, and the newest request is the one someone is waiting on.
	let tail: Promise<unknown> = Promise.resolve();

	const request = <T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> => {
		const combined = signal === undefined ? dead.signal : AbortSignal.any([signal, dead.signal]);
		// What the call is on account of, taken now: it's sent when its turn comes, when no handler is running to name it.
		const cause = hub.handlingMessage;
		// An already-aborted signal skips the call unsent.
		const run = tail.then(() => rpc.request("bablr." + name, args, { "timeoutMs": Infinity, "waitForResponderMs": 30000, "signal": combined, "cause": cause }) as Promise<T>);

		tail = run.catch(() => undefined);

		// Reject a queued call as soon as it's aborted, not when its turn comes.
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => {
				reject(combined.reason as Error);
			};

			combined.addEventListener("abort", onAbort, { "once": true });
			run.then(resolve, reject).finally(() => {
				combined.removeEventListener("abort", onAbort);
			});
		});
	};

	// What earlier builds kept in the workspace — verdicts in `.git/bablr/`, then spans and verdicts in
	// `.silo/local/bablr/` — is all derivable, and the worker's cache has what it came from: it just goes.
	for (const old of ["/workspace/.git/bablr", `/workspace/${LOCAL_DIR}/bablr`]) {
		void fs.promises.rm(old, { "recursive": true, "force": true }).catch(() => undefined);
	}

	// The last text's spans, so asking twice in a row (a run's statements, then its sites) asks the worker once.
	let last: { "source": string; "spans": Promise<Span[]> } | undefined;

	const spans = async (source: string, signal?: AbortSignal): Promise<Span[]> => {
		if (source === "") {
			return []; // BABLR has nothing to parse
		}

		if (last?.source !== source) {
			const asked = request<{ "spans"?: Span[]; "unparsable"?: string }>("spans", { "source": source }, signal).then((answer) => {
				if (answer.unparsable !== undefined || answer.spans === undefined) {
					throw new Unparsable(answer.unparsable ?? "BABLR can't parse it");
				}

				return answer.spans;
			});

			last = { "source": source, "spans": asked };
			asked.catch(() => {
				if (last?.spans === asked) {
					last = undefined;
				}
			});
		}

		return last.spans;
	};

	// The session's verdicts, keyed by a cheap content-pair hash: both changes panes, and the cosmetic extension, ask once
	// per content pair, not once per refresh.
	const verdicts = new Map<string, ChangeVerdict>();
	const classify = async (before: string, after: string, signal?: AbortSignal): Promise<ChangeVerdict> => {
		if (before === after) {
			return { "verdict": "cosmetic", "changedNodeIds": [], "changedLines": [] }; // identical — the only provably-correct shortcut
		}

		const key = before.length + ":" + after.length + ":" + fnv32(before) + ":" + fnv32(after);
		const known = verdicts.get(key);

		if (known !== undefined) {
			return known;
		}

		// Over [before, after]: verdict + changed nodes + their lines (from the worker's cached parses).
		const verdict = await request<ChangeVerdict>("verdict", { "contents": [before, after] }, signal);

		if (verdicts.size > 200) {
			verdicts.clear();
		}

		verdicts.set(key, verdict);

		return verdict;
	};

	return {
		"request": request,
		"spans": spans,
		"classify": classify,
		"dispose": () => {
			unlink();
			worker.terminate();
		}
	};
}
