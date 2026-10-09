/**
 * What went through the code under the cursor, across every run kept in git (RUNTIME-EVIDENCE.md, the second slice):
 * for a value site (`a?.b`'s `a`, `a ?? b`'s `a`, a parameter, a return), how many values came through, how often they
 * were nullish, which kinds, and a few of the values as this machine saw them; for a branch (`if`, `?:`, `&&`, `||`),
 * how often each arm ran. For a value site, the type TypeScript gives it beside the kinds runs saw (the capabilities
 * tsserver plugin's `_types.at`), so whether the types held is there to read.
 */
import type { EvidenceStore, Placed, SpanEvidence } from "./evidence";
import * as vscode from "vscode";

const CODE = [{ "scheme": "file", "language": "typescript" }, { "scheme": "file", "language": "typescriptreact" }, { "scheme": "file", "language": "javascript" }, { "scheme": "file", "language": "javascriptreact" }];

/** What a value site is, by its node type (BABLR's). */
function valueSite(type: string | undefined): string {
	if (type === "MemberExpression" || type === "CallExpression") {
		return "`?.` — what it tested";
	}

	if (type === "BinaryExpression") {
		return "`??` — its left side";
	}

	if (type === "Return" || type === "ArrowFunctionExpression") {
		return "Returned";
	}

	return type?.endsWith("Pattern") === true || type === "Identifier" ? "Parameter — what was passed" : "Values";
}

/** A branch's name and its arms', by its node type. */
function branchSite(type: string | undefined): { "name": string; "arms": string[] } {
	if (type === "If") {
		return { "name": "`if`", "arms": ["then", "else"] };
	}

	if (type === "TernaryExpression") {
		return { "name": "`?:`", "arms": ["true", "false"] };
	}

	return type === "BinaryExpression" ? { "name": "`&&` / `||`", "arms": ["right side ran", "short-circuited"] } : { "name": "Branch", "arms": ["first", "second"] };
}

const count = (n: number): string => n.toLocaleString("en-US");
const times = (n: number): string => `${count(n)}×`;
const runs = (n: number): string => `${count(n)} run${n === 1 ? "" : "s"}`;
const share = (part: number, whole: number): string => `${whole === 0 ? 0 : Math.round(part / whole * 100)}%`;
const bar = (part: number, whole: number): string => "█".repeat(Math.max(1, Math.round(part / Math.max(whole, 1) * 10))).padEnd(10, "░");

/** The hover's text for one span's evidence (value or branch), with the type TypeScript gives it when known. */
export function describe(evidence: SpanEvidence, type: string | undefined, declared?: string): string | undefined {
	const { value, branch } = evidence;

	if (value !== undefined) {
		const kinds = Object.entries(value.tags).sort(([, a], [, b]) => b - a).map(([tag, n]) => `\`${tag}\` ${bar(n, value.seen)} ${share(n, value.seen)}`);
		const samples = evidence.samples === undefined ? [] : [`Seen here: ${evidence.samples.map((sample) => typeof sample === "string" ? JSON.stringify(sample) : String(sample)).join(", ")}`];

		const types = declared === undefined ? [] : [`Declared \`${declared}\` · observed ${Object.keys(value.tags).map((tag) => `\`${tag}\``).join(", ")}`];

		return [`**${valueSite(type)}** — ${count(value.seen)} value${value.seen === 1 ? "" : "s"} in ${runs(value.ever)}, ${value.nullish === 0 ? "never nullish" : `nullish ${times(value.nullish)}`}`, ...kinds, ...types, ...samples].join("\n\n");
	}

	if (branch !== undefined) {
		const { name, arms } = branchSite(type);
		const total = branch.arms.reduce((sum, n) => sum + n, 0);

		return `**${name}** — ${branch.arms.map((n, arm) => (n === 0 ? `${arms[arm] ?? `arm ${arm + 1}`} never ran` : `${arms[arm] ?? `arm ${arm + 1}`} ${times(n)} (${share(n, total)})`)).join(" · ")}, in ${runs(branch.ever)}`;
	}

	return undefined;
}

export function registerHover(context: vscode.ExtensionContext, store: EvidenceStore): void {
	context.subscriptions.push(vscode.languages.registerHoverProvider(CODE, {
		"provideHover": async (document, position) => {
			const offset = document.offsetAt(position);
			const placed = await store.placed(document);
			// The innermost span under the cursor with values or a branch: the code the cursor is on.
			const here = (placed ?? []).filter(({ start, end, evidence }) => start <= offset && offset < end && (evidence.value !== undefined || evidence.branch !== undefined)).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] as Placed | undefined;
			const declared = here?.evidence.value === undefined ? undefined : await Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "types"?: (string | null)[] } } | undefined>("typescript.tsserverRequest", "_types.at", { "file": document.uri, "ranges": [{ "start": here.start, "end": here.end }] })).then((response) => response?.body?.types?.[0] ?? undefined, () => undefined);
			const text = here === undefined ? undefined : describe(here.evidence, here.type, declared);

			return text === undefined ? undefined : new vscode.Hover(new vscode.MarkdownString(text), new vscode.Range(document.positionAt(here!.start), document.positionAt(here!.end)));
		}
	}));
}
