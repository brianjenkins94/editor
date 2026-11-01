/**
 * A hidden tab's timers, kept. A browser holds back a hidden page's timers — Chrome's budget for a background page's
 * CPU, and Brave's with it: once a page has spent it (this one, loading a repository), a 10 s setTimeout hadn't fired
 * after 91 s, and an idle hidden page's 1 s interval ran 7 times in 30 s (2026-10-31) — while the page still handles
 * its messages at once, and a worker's timers keep time. An agent drives the editor while nobody looks at its tab, and
 * then whatever waits on a timer stops: logs' flush, runs' ends, requests' timeouts. So in each realm on the page's
 * thread (main.tsx's two, the workbench's), a timer set while the tab is hidden — or one of LONG_MS or more, which may
 * outlast the tab being shown — is a worker's, its firing a message the realm handles. A short one while the tab is
 * shown, most of them, is the realm's own.
 */

/** A timer this long or longer is a worker's however the tab is: the tab can be hidden before it's due. */
const LONG_MS = 1000;

/** The worker's timers' ids, apart from the realm's own (which count up from 1). */
const FIRST_ID = 1_000_000_000;

/** The worker: a timer (or an interval) per id, its id posted back each time it fires; an id alone clears it. */
const CLOCK = "const timers = new Map(); onmessage = ({ data }) => { const { id, ms, repeat } = data; clearTimeout(timers.get(id)); clearInterval(timers.get(id)); timers.delete(id); if (ms !== undefined) { timers.set(id, repeat ? setInterval(() => { postMessage(id); }, ms) : setTimeout(() => { timers.delete(id); postMessage(id); }, ms)); } };";

type Callback = (...args: unknown[]) => void;

/** The realm whose timers these are: its own timers, and what makes the worker and says whether the tab is hidden. */
interface Realm {
	"setTimeout": typeof globalThis.setTimeout;
	"setInterval": typeof globalThis.setInterval;
	"clearTimeout": typeof globalThis.clearTimeout;
	"clearInterval": typeof globalThis.clearInterval;
	"Worker"?: typeof Worker;
	"document"?: { "hidden": boolean };
	"__hiddenTabTimers"?: true;
}

/** Give `realm` timers that keep time in a hidden tab (once a realm; none where it can't make a worker). */
export function installHiddenTabTimers(realm: Realm = globalThis as unknown as Realm): void {
	if (realm.__hiddenTabTimers === true || realm.Worker === undefined) {
		return;
	}

	let clock: Worker;

	try {
		clock = new realm.Worker(URL.createObjectURL(new Blob([CLOCK], { "type": "text/javascript" })));
	} catch {
		return; // (no worker here: the realm's own timers)
	}

	realm.__hiddenTabTimers = true;

	const own = { "setTimeout": realm.setTimeout.bind(realm), "setInterval": realm.setInterval.bind(realm), "clearTimeout": realm.clearTimeout.bind(realm), "clearInterval": realm.clearInterval.bind(realm) };
	const pending = new Map<number, { "callback": Callback; "args": unknown[]; "repeat": boolean }>();
	let next = FIRST_ID;

	clock.addEventListener("message", ({ data }: MessageEvent<number>) => {
		const timer = pending.get(data);

		if (timer === undefined) {
			return;
		}

		if (!timer.repeat) {
			pending.delete(data);
		}

		timer.callback.apply(realm, timer.args);
	});

	const set = (repeat: boolean) => (handler: unknown, ms?: number, ...args: unknown[]): number => {
		const delay = Number(ms) || 0;

		// (a string to evaluate, or a short timer while the tab is shown: the realm's own)
		if (typeof handler !== "function" || (realm.document?.hidden !== true && delay < LONG_MS)) {
			return (repeat ? own.setInterval : own.setTimeout)(handler as Callback, ms, ...args) as unknown as number;
		}

		const id = next;

		next += 1;
		pending.set(id, { "callback": handler as Callback, "args": args, "repeat": repeat });
		clock.postMessage({ "id": id, "ms": delay, "repeat": repeat });

		return id;
	};
	const clear = (theirs: (id?: number) => void) => (id?: number): void => {
		if (typeof id === "number" && id >= FIRST_ID) {
			if (pending.delete(id)) {
				clock.postMessage({ "id": id });
			}
		} else {
			theirs(id);
		}
	};

	realm.setTimeout = set(false) as unknown as typeof globalThis.setTimeout;
	realm.setInterval = set(true) as unknown as typeof globalThis.setInterval;
	// (either clears either, as the browser's do)
	realm.clearTimeout = clear(own.clearTimeout as (id?: number) => void) as typeof globalThis.clearTimeout;
	realm.clearInterval = clear(own.clearInterval as (id?: number) => void) as typeof globalThis.clearInterval;
}

// This realm's, as it's imported: first of an entry's imports (main.tsx, workbench-entry.tsx), before anything else
// can take the realm's own timers to keep.
installHiddenTabTimers();
