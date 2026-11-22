const LONG_MS = 1000;

const FIRST_ID = 1_000_000_000;

const CLOCK = "const timers = new Map(); onmessage = ({ data }) => { const { id, ms, repeat } = data; clearTimeout(timers.get(id)); clearInterval(timers.get(id)); timers.delete(id); if (ms !== undefined) { timers.set(id, repeat ? setInterval(() => { postMessage(id); }, ms) : setTimeout(() => { timers.delete(id); postMessage(id); }, ms)); } };";

type Callback = (...args: unknown[]) => void;

interface Realm {
	"setTimeout": typeof globalThis.setTimeout;
	"setInterval": typeof globalThis.setInterval;
	"clearTimeout": typeof globalThis.clearTimeout;
	"clearInterval": typeof globalThis.clearInterval;
	"Worker"?: typeof Worker;
	"document"?: { "hidden": boolean };
	"__hiddenTabTimers"?: true;
}

export function installHiddenTabTimers(realm: Realm = globalThis as unknown as Realm): void {
	if (realm.__hiddenTabTimers === true || realm.Worker === undefined) {
		return;
	}

	let clock: Worker;

	try {
		clock = new realm.Worker(URL.createObjectURL(new Blob([CLOCK], { "type": "text/javascript" })));
	} catch {
		return;
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
	realm.clearTimeout = clear(own.clearTimeout as (id?: number) => void) as typeof globalThis.clearTimeout;
	realm.clearInterval = clear(own.clearInterval as (id?: number) => void) as typeof globalThis.clearInterval;
}

installHiddenTabTimers();
