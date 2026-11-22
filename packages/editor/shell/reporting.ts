import type { Hub } from "@brianjenkins94/hub";
import release from "editor:release";

interface Event { "name": string; "detail"?: string }

interface ErrorReport { "message": string; "stack"?: string; "source"?: string }

const FLUSH = 5000;

const REPORTS = 10;

const SAME = 60_000;

export interface Reporting {
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
