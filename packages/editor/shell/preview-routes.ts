import type { Hub } from "@brianjenkins94/hub";
import type { RouteAnswer, Routed, RouteMatch } from "@brianjenkins94/playwright/route";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { matchesCrossed } from "@brianjenkins94/playwright/route";
import { logger } from "@brianjenkins94/util/logger";
import { parseVirtual } from "../shared/virtual-path";

const log = logger({ "source": "shell" });

const WAIT_FOR_ONE_MS = 20_000;

const ANSWER_WITHIN_MS = 100_000;

export interface HeldRequest { "port": number; "client"?: string; "url": string; "method": string; "headers": Record<string, string>; "body"?: string; "resourceType": string }

export interface PreviewRoutes {
	"routes": (page: string, matches: RouteMatch[]) => void;
	"routed": (page: string) => Promise<Routed[] | undefined>;
	"answer": (id: string, answer: RouteAnswer) => void;
	"release": (page: string) => void;
}

export function installPreviewRoutes(hub: Hub, windowOf: (page: string) => Window | null | undefined): PreviewRoutes {
	const rpc = createRpcClient(hub);
	const matchesOf = new Map<string, RouteMatch[]>();
	const queued = new Map<string, Routed[]>();
	const waiting = new Map<string, (held: Routed[] | undefined) => void>();
	const pending = new Map<string, (answer: RouteAnswer) => void>();
	const ownedBy = new Map<string, string>();
	let tab: Promise<string> | undefined;

	const tell = async (): Promise<void> => {
		tab ??= rpc.request("virtual.tab", undefined, { "timeoutMs": 10_000 }) as Promise<string>;
		hub.publish("playwright.routes", { "tab": await tab, "routing": matchesOf.size > 0 });
	};

	const deliver = (page: string, held: Routed): void => {
		const waiter = waiting.get(page);

		if (waiter === undefined) {
			queued.set(page, [...queued.get(page) ?? [], held]);
		} else {
			waiting.delete(page);
			waiter([held]);
		}
	};

	const pageFor = (request: HeldRequest): string | undefined => {
		const here = [...matchesOf.keys()].filter((page) => {
			const href = windowOf(page)?.location.href;

			return href !== undefined && (parseVirtual(new URL(href).pathname)?.port ?? 0) === request.port;
		});

		const theOne = here.find((page) => windowOf(page)?.location.href === request.client);

		return request.port === 0 ? theOne : theOne ?? here[0];
	};

	serve(hub, "playwright.route", async (args) => {
		const request = args as HeldRequest;
		const page = pageFor(request);

		if (page === undefined || !(matchesOf.get(page) ?? []).some((match) => matchesCrossed(match, request.url))) {
			return { "continue": true };
		}

		return log.span("editor.shell.preview-routes.hold", { "op": request.method, "port": request.port, "type": request.resourceType }, async (span) => {
			const id = crypto.randomUUID();
			const answered = new Promise<RouteAnswer>((resolve) => {
				pending.set(id, resolve);
				setTimeout(() => {
					if (pending.delete(id)) {
						span.warn("no answer from the test's route: continued");
						resolve({ "continue": true });
					}
				}, ANSWER_WITHIN_MS);
			});

			ownedBy.set(id, page);
			deliver(page, { "id": id, "url": request.url, "method": request.method, "headers": request.headers, ...request.body === undefined ? {} : { "body": request.body }, "resourceType": request.resourceType });

			const answer = await answered;

			span.end({ "answer": Object.keys(answer)[0] });

			return answer;
		});
	});

	return {
		"routes": (page, matches) => {
			if (matches.length === 0) {
				matchesOf.delete(page);
			} else {
				matchesOf.set(page, matches);
			}

			void tell();
		},
		"routed": async (page) => {
			const held = queued.get(page) ?? [];

			if (held.length > 0) {
				queued.delete(page);

				return held;
			}

			if (!matchesOf.has(page)) {
				return undefined;
			}

			return new Promise((resolve) => {
				waiting.get(page)?.([]);
				waiting.set(page, resolve);
				setTimeout(() => {
					if (waiting.get(page) === resolve) {
						waiting.delete(page);
						resolve([]);
					}
				}, WAIT_FOR_ONE_MS);
			});
		},
		"answer": (id, answer) => {
			ownedBy.delete(id);
			pending.get(id)?.(answer);
			pending.delete(id);
		},
		"release": (page) => {
			if (!matchesOf.delete(page) && !queued.has(page)) {
				return;
			}

			queued.delete(page);
			waiting.get(page)?.(undefined);
			waiting.delete(page);

			for (const [id, owner] of ownedBy) {
				if (owner === page) {
					ownedBy.delete(id);
					pending.get(id)?.({ "continue": true });
					pending.delete(id);
				}
			}

			void tell();
		}
	};
}
