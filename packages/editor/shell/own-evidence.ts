import type { SiteObservation } from "@brianjenkins94/editor-api";
import type { ModuleEvidence } from "@brianjenkins94/editor-api/recorded";
import type { Hub } from "@brianjenkins94/hub";
import type { ShellFeature } from "./feature";
import { createRpcClient } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";

const log = logger({ "source": "shell" });

const COVERAGE_CHANNEL = "editor.coverage";

const ASK_MS = 1000;

const KEEP_EVERY_MS = 10 * 60_000;

export interface RealmAnswer { "realm": string; "ran"?: Record<string, [number, number][]>; "modules"?: ModuleEvidence[] }

export async function askRealms(ask: Record<string, unknown>): Promise<RealmAnswer[]> {
	const channel = new BroadcastChannel(COVERAGE_CHANNEL);
	const nonce = crypto.randomUUID();
	const answers: RealmAnswer[] = [];

	channel.addEventListener("message", ({ data }: MessageEvent<RealmAnswer & { "answer"?: string }>) => {
		if (data.answer === nonce) {
			answers.push(data);
		}
	});
	channel.postMessage({ ...ask, "nonce": nonce });
	await new Promise((resolve) => {
		setTimeout(resolve, ASK_MS);
	});
	channel.close();

	return answers;
}

export const inFull = (): boolean => (globalThis as { "__evidence"?: { "full"?: true } }).__evidence?.full === true;

const siteKey = ({ site, start, end }: SiteObservation): string => `${site}:${start.join(",")}:${end.join(",")}`;

function tagsSince(before: Record<string, number> = {}, now: Record<string, number> = {}): Record<string, number> {
	return Object.fromEntries(Object.entries(now).flatMap(([tag, count]) => (count - (before[tag] ?? 0) > 0 ? [[tag, count - (before[tag] ?? 0)]] : [])));
}

export function deltaOf(before: ModuleEvidence | undefined, now: ModuleEvidence): ModuleEvidence | undefined {
	const statements = now.statements.flatMap((statement, index) => {
		const count = statement.count - (before?.statements[index]?.count ?? 0);

		return count > 0 ? [{ ...statement, "count": count }] : [];
	});
	const earlier = new Map((before?.sites ?? []).map((site) => [siteKey(site), site]));
	const sites = now.sites.flatMap((site): SiteObservation[] => {
		const was = earlier.get(siteKey(site));

		if (site.arms !== undefined) {
			const arms = site.arms.map((count, arm) => count - (was?.arms?.[arm] ?? 0));

			return arms.some((count) => count > 0) ? [{ ...site, "arms": arms }] : [];
		}

		const seen = (site.seen ?? 0) - (was?.seen ?? 0);

		return seen > 0 ? [{ ...site, "seen": seen, "nullish": (site.nullish ?? 0) - (was?.nullish ?? 0), "tags": tagsSince(was?.tags, site.tags) }] : [];
	});

	return statements.length === 0 && sites.length === 0 ? undefined : { ...now, "statements": statements, "sites": sites };
}

const taken = new Map<string, ModuleEvidence>();

export const driving = new Set<string>();

export async function keepEvidence(hub: Hub, title: string, answers: RealmAnswer[]): Promise<number> {
	const modules = answers.flatMap(({ realm, "modules": theirs = [] }) => theirs.flatMap((module) => {
		const key = `${realm}\0${module.file}\0${module.version}`;
		const since = deltaOf(taken.get(key), module);

		taken.set(key, module);

		return since === undefined ? [] : [since];
	}));
	const [first, ...rest] = modules;

	if (first === undefined) {
		return 0;
	}

	const { id } = await createRpcClient(hub).request("runs.begin", { "title": title, "cwd": "/workspace", "runtime": "browser" }, { "timeoutMs": 10_000 }) as { "id": string };
	const coverage = ({ file, version, statements, sites }: ModuleEvidence): Record<string, unknown> => ({ "file": file, "version": version, "source": "", "statements": statements, "sites": sites });

	hub.publish("evidence.observed", { "runId": id, ...coverage(first), "files": rest.map(coverage) });
	hub.publish(`node.exit.${id}`, { "exitCode": 0 });

	return modules.length;
}

export const ownEvidence: ShellFeature = {
	"start": ({ hub }) => {
		if (!inFull()) {
			return;
		}

		let keeping = false;
		const keep = (): void => {
			if (keeping || driving.size > 0) {
				return;
			}

			keeping = true;
			void log.span("editor.shell.own-evidence.keep", {}, async (span) => {
				const realms = (await askRealms({ "ask": "realms" })).map(({ realm }) => realm);
				const kept = await keepEvidence(hub, "This editor, as used", await askRealms({ "ask": "full", "realms": realms }));

				span.end({ "count": realms.length, "files": kept });
			}).catch((error: unknown) => {
				log.warn("this editor's own evidence wasn't kept", { "error": error instanceof Error ? error.message : String(error) });
			}).finally(() => {
				keeping = false;
			});
		};

		setInterval(keep, KEEP_EVERY_MS);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				keep();
			}
		});
	}
};
