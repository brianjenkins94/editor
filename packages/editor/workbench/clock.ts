/**
 * Timers that keep time in a hidden tab. A browser holds back a hidden page's own timers while it still handles its
 * messages — Brave, measured 2026-10-31: a 10 s setTimeout in the editor's page hadn't fired after 91 s, while the
 * debug worker's 70 s wait took 70.0 s. So a deadline something outside the page waits on (an agent's call: a test
 * run's answer, its stall check, its wait for the editor) is kept by a worker's timer, its firing a message the page
 * handles: one worker, made as it's first needed.
 */

/** The worker: a timer per id, its id posted back when it fires. */
const CLOCK = "const timers = new Map(); onmessage = ({ data }) => { clearTimeout(timers.get(data.id)); timers.delete(data.id); if (data.ms !== undefined) { timers.set(data.id, setTimeout(() => { timers.delete(data.id); postMessage(data.id); }, data.ms)); } };";

let worker: Worker | undefined;
let next = 0;
const due = new Map<number, () => void>();

function clock(): Worker | undefined {
	if (worker === undefined && typeof Worker !== "undefined") {
		try {
			worker = new Worker(URL.createObjectURL(new Blob([CLOCK], { "type": "text/javascript" })));
			worker.addEventListener("message", ({ data }: MessageEvent<number>) => {
				const fire = due.get(data);

				due.delete(data);
				fire?.();
			});
		} catch {
			// (no worker here: the page's own timers)
		}
	}

	return worker;
}

/** `callback` in `ms`, the tab hidden or not; the function returned cancels it. */
export function after(ms: number, callback: () => void): () => void {
	const host = clock();

	if (host === undefined) {
		const timer = setTimeout(callback, ms);

		return () => {
			clearTimeout(timer);
		};
	}

	const id = next;

	next += 1;

	due.set(id, callback);
	host.postMessage({ "id": id, "ms": ms });

	return () => {
		if (due.delete(id)) {
			host.postMessage({ "id": id });
		}
	};
}

/** `callback` every `ms`, the tab hidden or not; the function returned stops it. */
export function every(ms: number, callback: () => void): () => void {
	let cancel = (): void => undefined;
	let stopped = false;
	const tick = (): void => {
		cancel = after(ms, () => {
			if (!stopped) {
				tick();
				callback();
			}
		});
	};

	tick();

	return () => {
		stopped = true;
		cancel();
	};
}
