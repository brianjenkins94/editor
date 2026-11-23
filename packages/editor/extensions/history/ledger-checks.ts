import type { Feature } from "@brianjenkins94/util/silo/features";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { declaredFeatures, drift, isOwnedCode, parseLedger } from "@brianjenkins94/util/silo/ledger";
import { ranByFile } from "@brianjenkins94/util/silo/observed";

const DOC_LINES = 60;

export interface Decisions {
	"target": string;
	"ledger": ({ "name": string } & ReturnType<typeof parseLedger>[string])[];
	"docs": { "doc": string; "line": number; "heading": string; "text": string }[];
	"counts": { "docs": number };
}

export function decisionsFor(target: unknown, ledgerText: string | undefined, texts: ReadonlyMap<string, string>): Decisions | undefined {
	if (typeof target !== "string" || target.trim() === "") {
		return undefined;
	}

	const wanted = target.trim().replace(/^\/workspace\//u, "");
	const isPath = wanted.includes("/") || /\.[a-z]+$/u.test(wanted);
	const names = isPath
		? [
				...new Set([wanted, wanted.split("/").at(-1) ?? wanted])
			]
		: [wanted];
	const words = names.map((name) => new RegExp(`(?<![\\w$/.-])${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w$])`, "u"));
	const said = (text: string | undefined): boolean => text !== undefined && words.some((word) => word.test(text));
	const holds = (paths: string[] | undefined): boolean => isPath && (paths ?? []).some((each) => wanted === each.replace(/\/+$/u, "") || wanted.startsWith(each.replace(/\/+$/u, "") + "/"));
	const ledger = parseLedger(ledgerText);
	const entries = Object.entries(ledger).filter(([name, entry]) => said(name) || said(entry.why) || said(entry.key) || holds(entry.paths) || holds(entry.tests) || (entry.ways ?? []).some((key) => said(key))).map(([name, entry]) => ({ "name": name, ...entry }));
	const docs: Decisions["docs"] = [];

	for (const [file, text] of [...texts].filter(([path]) => path.endsWith(".md")).sort(([left], [right]) => left.localeCompare(right))) {
		let heading = "";

		for (const [index, line] of text.split("\n").entries()) {
			if (/^#{1,6} /u.test(line)) {
				heading = line.replace(/^#+ /u, "");
			} else if (said(line)) {
				docs.push({
					"doc": file,
					"line": index + 1,
					"heading": heading,
					"text": line.trim().slice(0, 240)
				});
			}
		}
	}

	return {
		"target": wanted,
		"ledger": entries,
		"docs": docs.slice(0, DOC_LINES),
		"counts": { "docs": docs.length }
	};
}

export interface Placed {
	"path": string;
	"line": number;
	"length": number;
	"check": string;
	"message": string;
}

export function driftOf(ledgerText: string | undefined, files: ReadonlySet<string>, texts: ReadonlyMap<string, string>, features: ReadonlyMap<string, Feature>, today: string, reachText?: string): Placed[] {
	const ledger = parseLedger(ledgerText);
	const found = drift(ledger, {
		"today": today,
		"ways": [
			...features.values()
		].map((feature) => ({
			"key": feature.key,
			"facet": feature.facet,
			"id": feature.id,
			"sides": feature.sides
		})),
		"exists": (path) => files.has(path) || [...files].some((file) => file.startsWith(path.replace(/\/+$/u, "") + "/")),
		"docs": [...texts].filter(([path]) => path.endsWith(".md")).map(([path, text]) => ({ "file": path, "text": text })),
		"code": [...texts].filter(([path]) => !path.endsWith(".md") && includeByDefault(path)).map(([path, text]) => ({ "file": path, "text": text })),
		...declaredFeatures(ledger).length === 0
			? {}
			: {
					"owned": {
						"files": [...files].filter(isOwnedCode),
						"ran": ranByFile(reachText)
					}
				}
	});
	const lines = (ledgerText ?? "").split("\n");

	return found.map((each) => {
		const message = `${each.check}: ${each.message} — change the code: ${each.code}; or the decision: ${each.decision}`;

		if (each.check === "unowned file" || each.check === "owned twice") {
			return {
				"path": each.message.slice(0, each.message.indexOf(" is owned")),
				"line": 0,
				"length": 0,
				"check": each.check,
				"message": message
			};
		}

		const line = Math.max(0, each.entry === undefined
			? -1
			: lines.findIndex((text) => text.includes(JSON.stringify(each.entry))));

		return {
			"path": ledgerPath(),
			"line": line,
			"length": lines[line]?.length ?? 0,
			"check": each.check,
			"message": message
		};
	});
}
