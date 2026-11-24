import type { RealmsReading } from "@brianjenkins94/editor-api/runtime";

export const DEVTOOLS_PORT = 9222;

export const DEVTOOLS_SOCKET = `ws://127.0.0.1:${String(DEVTOOLS_PORT)}/devtools/browser/editor`;

export interface DevtoolsTarget { "targetId": string; "type": string; "title": string; "url": string }

interface Message { "id"?: number; "method"?: string; "params"?: Record<string, unknown>; "sessionId"?: string }

const TYPES: Record<string, string> = {
	"Window": "page",
	"DedicatedWorkerGlobalScope": "worker",
	"SharedWorkerGlobalScope": "shared_worker",
	"ServiceWorkerGlobalScope": "service_worker"
};

export function targetsOf(reading: RealmsReading | undefined): (DevtoolsTarget & { "bytes": number })[] {
	return (reading?.realms ?? []).map(({ url, scope, bytes }) => {
		const type = TYPES[scope] ?? "other";

		return { "targetId": `${type}:${url}`, "type": type, "title": url.split("/").filter(Boolean).at(-1) ?? url, "url": url, "bytes": bytes };
	});
}

export function devtoolsJson(path: string, reading: RealmsReading | undefined, userAgent: string): unknown {
	if (path === "/json/version") {
		return { "Browser": "Editor/1.0", "Protocol-Version": "1.3", "User-Agent": userAgent, "webSocketDebuggerUrl": DEVTOOLS_SOCKET };
	}

	if (path === "/json" || path === "/json/list") {
		return targetsOf(reading).map(({ targetId, type, title, url }) => ({ "id": targetId, "type": type, "title": title, "url": url }));
	}

	return undefined;
}

export function devtoolsSession(realms: () => Promise<RealmsReading | undefined>, send: (message: object) => void): (data: string) => Promise<void> {
	const sessions = new Map<string, { "target": DevtoolsTarget; "workers": Set<string> }>();
	let made = 0;
	const attach = (target: DevtoolsTarget, under?: string): string => {
		made += 1;

		const sessionId = `session-${String(made)}`;

		sessions.set(sessionId, { "target": target, "workers": new Set() });
		send({ "method": "Target.attachedToTarget", "params": { "sessionId": sessionId, "targetInfo": { ...target, "attached": true }, "waitingForDebugger": false }, ...under === undefined ? {} : { "sessionId": under } });

		return sessionId;
	};
	const targetInfo = ({ targetId, type, title, url }: DevtoolsTarget): DevtoolsTarget & { "attached": boolean } => ({ "targetId": targetId, "type": type, "title": title, "url": url, "attached": [...sessions.values()].some((session) => session.target.targetId === targetId) });
	const answer = async ({ method, params = {}, sessionId }: Message): Promise<{ "result": unknown } | { "error": { "code": number; "message": string } }> => {
		const session = sessionId === undefined ? undefined : sessions.get(sessionId);

		if (sessionId !== undefined && session === undefined) {
			return { "error": { "code": -32001, "message": `Session with given id not found.` } };
		}

		switch (method) {
			case "Browser.getVersion":
				return { "result": { "protocolVersion": "1.3", "product": "Editor/1.0", "revision": "", "userAgent": "", "jsVersion": "" } };
			case "Target.getTargets":
				return { "result": { "targetInfos": targetsOf(await realms()).map(targetInfo) } };
			case "Target.attachToTarget": {
				const target = targetsOf(await realms()).find((each) => each.targetId === params["targetId"]);

				return target === undefined ? { "error": { "code": -32602, "message": "No target with given id found" } } : { "result": { "sessionId": attach(targetInfo(target)) } };
			}
			case "Target.setAutoAttach": {
				if (session?.target.type === "page" && params["autoAttach"] === true) {
					for (const worker of targetsOf(await realms()).filter((each) => each.type !== "page" && !session.workers.has(each.targetId))) {
						session.workers.add(worker.targetId);
						attach(targetInfo(worker), sessionId);
					}
				}

				return { "result": {} };
			}
			case "Target.detachFromTarget": {
				const detached = typeof params["sessionId"] === "string" ? params["sessionId"] : sessionId;

				if (detached !== undefined && sessions.delete(detached)) {
					send({ "method": "Target.detachedFromTarget", "params": { "sessionId": detached } });
				}

				return { "result": {} };
			}
			case "Runtime.runIfWaitingForDebugger":
			case "Runtime.enable":
				return { "result": {} };
			case "Runtime.getHeapUsage": {
				const realm = session === undefined ? undefined : targetsOf(await realms()).find((each) => each.targetId === session.target.targetId);

				return realm === undefined ? { "error": { "code": -32000, "message": "No heap usage for this target: the editor hasn't measured it" } } : { "result": { "usedSize": realm.bytes, "totalSize": realm.bytes, "embedderHeapUsedSize": 0, "backingStorageSize": 0 } };
			}
			default:
				return { "error": { "code": -32601, "message": `'${String(method)}' wasn't found` } };
		}
	};

	return async (data) => {
		let message: Message;

		try {
			message = JSON.parse(data) as Message;
		} catch {
			return;
		}

		const answered = await answer(message);

		send({ "id": message.id, ...answered, ...message.sessionId === undefined ? {} : { "sessionId": message.sessionId } });
	};
}
