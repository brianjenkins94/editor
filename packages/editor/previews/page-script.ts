import { installPageEvidence } from "./page-evidence";

const CHANNEL = "editor-evidence";
const STOPS_CHANNEL = "editor-stops";

function host(): Window | undefined {
	const mine = /\/__virtual__\/[^/]+\/\d+/u.exec(location.pathname)?.[0];
	let current: Window = window;

	if (mine === undefined) {
		return undefined;
	}

	try {
		while (current.parent !== current && current.parent.location.pathname.includes(mine)) {
			current = current.parent;
		}
	} catch { /* a parent we can't read: the top we have */ }

	return current.parent === current
		? undefined
		: current.parent;
}

const to = host();
const page = crypto.randomUUID();
const port = Number(/\/__virtual__\/[^/]+\/(\d+)/u.exec(location.pathname)?.[1]);

if (to !== undefined) {
	const { flush } = installPageEvidence((modules, packages) => {
		to.postMessage({
			"channel": CHANNEL,
			"port": port,
			"page": page,
			"modules": modules,
			"packages": packages
		}, location.origin);
	}, (stops) => {
		to.postMessage({
			"channel": STOPS_CHANNEL,
			"port": port,
			"stops": stops
		}, location.origin);
	});

	addEventListener("message", (event: MessageEvent) => {
		if ((event.data as { "channel"?: unknown } | null)?.channel === `${CHANNEL}-flush`) {
			flush();
		}
	});
}
