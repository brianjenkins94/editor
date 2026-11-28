import type { ModuleEvidence } from "@brianjenkins94/editor-api/recorded";
import { installPageEvidence } from "./page-evidence";

const CHANNEL = "editor.coverage";

interface Evidence { "module": unknown; "evidence": () => ModuleEvidence[]; "publish"?: () => void; "full"?: true }

interface Ask { "ask"?: string; "nonce"?: string; "realms"?: string[]; "known"?: string[] }

const scope = globalThis as { "__evidence"?: Evidence };

function counted(modules: ModuleEvidence[], known: Set<string>, realm: string): { "file": string; "version": string; "counts": number[]; "statements"?: number[][] }[] {
	return modules.map(({ file, version, statements }) => ({
		"file": file,
		"version": version,
		"counts": statements.map(({ count }) => count),
		...known.has(`${realm}\0${file}\0${version}`) ? {} : { "statements": statements.map(({ start, end }) => [...start, ...end]) }
	}));
}

function ranOf(modules: ModuleEvidence[]): Record<string, [number, number][]> {
	const ran: Record<string, [number, number][]> = {};

	for (const { file, statements } of modules) {
		for (const { start, end, count } of statements) {
			if (count > 0) {
				(ran[file] ??= []).push([start[0], end[0]]);
			}
		}
	}

	return ran;
}

if (scope.__evidence?.full !== true) {
	installPageEvidence(() => undefined);

	const evidence = scope.__evidence!;
	const realm = Math.random().toString(36).slice(2);
	let channel: BroadcastChannel | undefined;

	try {
		channel = new BroadcastChannel(CHANNEL);
		channel.onmessage = ({ data }: MessageEvent<Ask | null>) => {
			const asked = data?.realms?.includes(realm) === true;

			if (data?.ask === "realms") {
				channel?.postMessage({ "answer": data.nonce, "realm": realm });
			} else if (data?.ask === "ran" && asked) {
				channel?.postMessage({ "answer": data.nonce, "realm": realm, "ran": ranOf(evidence.evidence()) });
			} else if (data?.ask === "evidence") {
				channel?.postMessage({ "answer": data.nonce, "realm": realm, "modules": counted(evidence.evidence(), new Set(data.known ?? []), realm) });
			} else if (data?.ask === "full" && asked) {
				channel?.postMessage({ "answer": data.nonce, "realm": realm, "modules": evidence.evidence() });
			}
		};
	} catch { /* a realm without BroadcastChannel answers nothing */ }

	Object.assign(evidence, {
		"full": true,
		"publish": () => {
			try {
				channel?.postMessage({ "answer": "published", "realm": realm, "modules": counted(evidence.evidence(), new Set(), realm) });
			} catch { /* nothing to publish to */ }
		}
	});

	try {
		globalThis.addEventListener("pagehide", () => {
			evidence.publish?.();
		});
	} catch { /* a realm with no page to leave */ }
}
