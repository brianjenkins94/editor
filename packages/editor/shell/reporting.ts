/**
 * What the editor reports to its API (packages/api/README.md, *Errors and timelines*, O4–O7), from the shell,
 * which holds the sign-in:
 *   - the session timeline's events, signed in only (signed out, nothing), batched every few seconds: the page shown, a
 *     repo loaded, and what the root and the workbench send as `session.event` (commands run, panes shown, runs);
 *   - every realm's uncaught errors (the root forwards them), and the shell's own, signed in or not, each answered with
 *     an id the person is shown, to quote. Signed out, the API keeps nothing of who but a daily IP hash.
 * Not from automation (tests' browsers, `navigator.webdriver`) or a copy of the editor that can't sign in: their errors
 * aren't anyone's to look into. Nor once the page is going (`pagehide`): what fails as it's torn down — IndexedDB's
 * "The database connection is closing", VS Code's log writes on it — is the leaving, not a fault.
 */
import type { Hub } from "@brianjenkins94/hub";
import release from "editor:release";

interface Event { "name": string; "detail"?: string }

interface ErrorReport { "message": string; "stack"?: string; "source"?: string }

/** How often batched events go. */
const FLUSH = 5000;

/** At most this many error reports a page, and the same error once a minute. */
const REPORTS = 10;

const SAME = 60_000;

export interface Reporting {
	/** Something happened, for the timeline (and the next error's breadcrumbs). */
	"event": (event: Event) => void;
}

export function startReporting(hub: Hub, onReported: (id: string) => void): Reporting {
	const queue: (Event & { "at": number })[] = [];
	const breadcrumbs: string[] = [];
	const recent = new Map<string, number>();
	let reports = 0;
	const quiet = navigator.webdriver;
	let leaving = false;

	window.addEventListener("pagehide", () => {
		leaving = true;
	});
	// (back from the back-forward cache, it's here again)
	window.addEventListener("pageshow", () => {
		leaving = false;
	});

	const event = (happened: Event): void => {
		breadcrumbs.push(happened.name);
		breadcrumbs.splice(0, Math.max(0, breadcrumbs.length - 10));
		queue.push({ ...happened, "at": Date.now() });
		queue.splice(0, Math.max(0, queue.length - 200));
	};

	const report = (error: ErrorReport): void => {
		const key = `${error.message}\n${(error.stack ?? "").split("\n")[1] ?? ""}`;
		const now = Date.now();

		// The workbench's errors arrive twice (its own listener and the error tap's): once a minute is enough.
		if (quiet || leaving || reports >= REPORTS || now - (recent.get(key) ?? 0) < SAME) {
			return;
		}

		recent.set(key, now);
		reports += 1;
		void import("./session").then(async (session) => {
			if (!session.canSignIn()) {
				return;
			}

			const id = await session.reportError({ "name": /^(\w+):/u.exec(error.stack ?? "")?.[1] ?? "Error", "message": error.message, "stack": error.stack, "source": error.source ?? "editor", "release": release, "breadcrumbs": [...breadcrumbs] });

			if (id !== undefined) {
				onReported(id);
			}
		});
	};

	hub.subscribe("session.event", (data) => {
		const sent = data as Event & { "error"?: ErrorReport };

		if (sent.name === "error" && sent.error !== undefined) {
			report(sent.error);
		} else if (typeof sent.name === "string") {
			event({ "name": sent.name, ...typeof sent.detail === "string" ? { "detail": sent.detail } : {} });
		}
	});

	// The shell's own: nothing else catches them (its realm has no error tap).
	window.addEventListener("error", (failure) => {
		report({ "message": failure.message || "uncaught error", "stack": failure.error instanceof Error ? failure.error.stack : undefined, "source": "shell" });
	});
	window.addEventListener("unhandledrejection", (failure) => {
		const reason = failure.reason as unknown;

		if (!(reason instanceof Error && (reason.name === "AbortError" || reason.name === "Canceled"))) {
			report({ "message": reason instanceof Error || reason instanceof ErrorEvent ? reason.message : String(reason), "stack": reason instanceof Error ? reason.stack : undefined, "source": "shell" });
		}
	});

	setInterval(() => {
		if (queue.length === 0 || quiet) {
			return;
		}

		const batch = queue.splice(0, 50);

		void import("./session").then(async (session) => {
			if (session.isSignedIn() && session.canSignIn()) {
				await session.postEvents(batch);
			}
		});
	}, FLUSH);

	event({ "name": "page.shown" });

	return { "event": event };
}
