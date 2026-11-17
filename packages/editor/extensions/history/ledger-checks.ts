/**
 * What the feature ledger says about the workspace, from its files as read (ledger.ts reads them and keeps them; this has
 * no editor of its own, so its tests give it files): what's been decided about a file or a name (`history.decisions`),
 * and `silo check`'s drift, each problem where it goes — on the ledger at the entry it's about (a dead end the ledger
 * doesn't name, at its top), or on the file no feature owns, or two do.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { declaredFeatures, drift, isOwnedCode, parseLedger } from "@brianjenkins94/util/silo/ledger";

/** The doc lines `history.decisions` lists, at most. */
const DOC_LINES = 60;

export interface Decisions {
	"target": string;
	"ledger": ({ "name": string } & ReturnType<typeof parseLedger>[string])[];
	"docs": { "doc": string; "line": number; "heading": string; "text": string }[];
	"counts": { "docs": number };
}

/** What's been decided about `target` (a path, or a file's name; or a name: an identifier, a feature, a way in's id): the
 *  ledger's entries naming it (or whose paths hold the file, or ways in name it), and each line of the docs naming it,
 *  under its heading. Nothing asked, nothing answered. */
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
	const entries = Object.entries(ledger).filter(([name, entry]) => said(name) || said(entry.why) || said(entry.key) || holds(entry.paths) || (entry.ways ?? []).some((key) => said(key))).map(([name, entry]) => ({ "name": name, ...entry }));
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

/** A drift problem, where it goes: the file (from the root), the line (0-based) and how much of it. */
export interface Placed {
	"path": string;
	"line": number;
	"length": number;
	"check": string;
	"message": string;
}

/** `silo check`'s drift over the workspace — every file there is (`files`), the docs' and code's text (`texts`), its ways
 *  in now (`features`) — each problem placed. */
export function driftOf(ledgerText: string | undefined, files: ReadonlySet<string>, texts: ReadonlyMap<string, string>, features: ReadonlyMap<string, Feature>, today: string): Placed[] {
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
						"files": [...files].filter(isOwnedCode)
					}
				}
	});
	const lines = (ledgerText ?? "").split("\n");

	return found.map((each) => {
		const message = `${each.check}: ${each.message} — change the code: ${each.code}; or the decision: ${each.decision}`;

		// (a file no feature owns, or two do: on that file — its path the message's start)
		if (each.check === "unowned file" || each.check === "owned twice") {
			return {
				"path": each.message.slice(0, each.message.indexOf(" is owned")),
				"line": 0,
				"length": 0,
				"check": each.check,
				"message": message
			};
		}

		// (at its entry's line in the ledger; a dead end the ledger doesn't name, at the top)
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
