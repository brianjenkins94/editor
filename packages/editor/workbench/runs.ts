import type { Hub } from "@brianjenkins94/hub";
import type { RunInfo } from "../shared/runs";
import { serve } from "@brianjenkins94/hub";

export interface RunHandle {
	"id": string;
	"update": (change: Partial<Pick<RunInfo, "port" | "title" | "kind" | "runtime">>) => void;
	"say": (text: string) => void;
	"end": (exitCode: number, stopped?: boolean) => void;
}

export interface RunRegistry {
	"start": (run: Pick<RunInfo, "title" | "kind" | "cwd" | "origin" | "port" | "entry" | "runtime">, stop: () => void, restart?: () => void) => RunHandle;
	"list": () => RunInfo[];
	"stop": (id: string) => boolean;
	"restart": (id: string) => void;
	"runningService": (matches: (run: RunInfo) => boolean) => RunInfo | undefined;
	"follow": (id: string, listener: (text: string) => void) => () => void;
	"onEnd": (listener: (run: RunInfo) => void) => () => void;
}

const KEEP_ENDED = 10;

const KEEP_SAID = 64_000;

function endedState(exitCode: number, stopped: boolean): RunInfo["state"] {
	if (stopped) {
		return "stopped";
	}

	return exitCode === 0 ? "exited" : "failed";
}

export function createRunRegistry(hub: Hub): RunRegistry {
	const running = new Map<string, { "info": RunInfo; "stop": () => void; "restart"?: () => void; "said": string; "followers": Set<(text: string) => void> }>();
	const ended: RunInfo[] = [];
	const endListeners = new Set<(run: RunInfo) => void>();

	const list = (): RunInfo[] => [...[...running.values()].map((run) => run.info).sort((left, right) => right.startedAt - left.startedAt), ...ended].map((info) => ({ ...info }));

	const registry: RunRegistry = {
		"start": (run, stop, restart) => {
			const id = crypto.randomUUID();
			const info: RunInfo = { ...run, "id": id, "state": "running", "startedAt": Date.now() };

			const entry = { "info": info, "stop": stop, "restart": restart, "said": "", "followers": new Set<(text: string) => void>() };

			running.set(id, entry);
			hub.publish("session.event", { "name": "run.started", "detail": info.kind });

			return {
				"id": id,
				"update": (change) => {
					if (running.has(id)) {
						Object.assign(info, change);
					}
				},
				"say": (text) => {
					entry.said = (entry.said + text).slice(-KEEP_SAID);

					for (const follower of entry.followers) {
						follower(text);
					}
				},
				"end": (exitCode, stopped = false) => {
					if (!running.delete(id)) {
						return;
					}

					Object.assign(info, { "state": endedState(exitCode, stopped), "endedAt": Date.now(), "exitCode": exitCode });
					hub.publish("session.event", { "name": "run.ended", "detail": info.state });
					ended.unshift(info);
					ended.length = Math.min(ended.length, KEEP_ENDED);

					for (const listener of endListeners) {
						try {
							listener({ ...info });
						} catch { /* a listener's failure isn't the run's */ }
					}
				}
			};
		},
		"list": list,
		"stop": (id) => {
			const run = running.get(id);

			if (run === undefined) {
				return false;
			}

			run.stop();

			return true;
		},
		"restart": (id) => {
			running.get(id)?.restart?.();
		},
		"runningService": (matches) => [...running.values()].map((run) => run.info).find((info) => info.kind === "service" && matches(info)),
		"follow": (id, listener) => {
			const run = running.get(id);

			if (run === undefined) {
				return () => undefined;
			}

			if (run.said !== "") {
				listener(run.said);
			}

			run.followers.add(listener);

			return () => {
				run.followers.delete(listener);
			};
		},
		"onEnd": (listener) => {
			endListeners.add(listener);

			return () => {
				endListeners.delete(listener);
			};
		}
	};

	serve(hub, "runs.list", () => list());
	serve(hub, "runs.stop", (args) => {
		const { id } = (args ?? {}) as { "id"?: unknown };

		return typeof id === "string" && registry.stop(id);
	});

	return registry;
}
