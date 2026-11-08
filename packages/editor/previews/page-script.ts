/**
 * The script a dev server puts first in every page it serves while it's instrumenting (workers/node-worker.ts), so it's
 * there before the app's modules run: runtime evidence's page runtime (page-evidence.ts), reporting to the editor showing
 * the preview. A report goes to the window the preview's top frame is in (the shell's preview window: its frames are
 * the dev server's, everything above them isn't), which passes it on as `evidence.preview` (shell/preview-windows.tsx); and
 * now, when the editor asks (`evidence.flush`, as its server's run ends).
 */
import { installPageEvidence } from "./page-evidence";

/** What a report is to the window hosting the preview. */
const CHANNEL = "editor-evidence";

/** The window the preview's top frame is in: above every frame of this dev server's (its pages are under
 *  `/__virtual__/<tab>/<port>/`), the first that isn't. */
function host(): Window | undefined {
	const mine = /\/__virtual__\/[^/]+\/\d+/u.exec(location.pathname)?.[0];
	let current: Window = window;

	if (mine === undefined) {
		return undefined; // not a dev server's page
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
	});

	// The editor asks every page of a server to report now, as the server's run ends (its windows may stay open).
	addEventListener("message", (event: MessageEvent) => {
		if ((event.data as { "channel"?: unknown } | null)?.channel === `${CHANNEL}-flush`) {
			flush();
		}
	});
}
