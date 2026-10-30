/**
 * A change's problems, against HEAD: `code.problems` { paths?, depth?, limit? } answers which diagnostics the working
 * tree's changes added and which they cleared, so an agent can tell what its change broke from the problems that were
 * there before it (a whole program's TypeScript errors hide the new ones). Its reader: agents' `code_problems`.
 *
 * - TypeScript's, from the history extension's tsserver plugin (`_history.problems`, extensions/history/ts-plugin.js): the changed
 *   files and the files importing them, each checked as the program is now and as it was at HEAD. Each changed file's
 *   symbols are asked first, so the server holds its project.
 * - ESLint's, per changed file (`_eslint.problems`, the eslint extension): its HEAD text and its text now, each linted at
 *   its path, customized as the Problems view's are.
 *
 * A problem is the same one at HEAD and now when its file, source, code and message are: lines move with an edit, so
 * where it is doesn't say. Now is what the editor has (an open file's unsaved edits included); HEAD is git's.
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { GitReader } from "./git-service";
import type { TypeScriptProjects } from "./ts-projects";
import { serve } from "@brianjenkins94/hub";

const ROOT = "/workspace";

/** A server path as the workspace names it. */
function relative(path: string): string {
	return path.startsWith(ROOT + "/") ? path.slice(ROOT.length + 1) : path;
}

/** The files TypeScript and ESLint read. */
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/** The problems listed at most, each way (the counts are all of them). */
const LISTED = 200;

/** How often, and how far apart, the TypeScript server is asked while it isn't ready (see typescriptProblems). */
const TRIES = 5;
const TRY_MS = 1500;

/** A diagnostic, where it is in its side's text (1-based). */
export interface Problem {
	"file": string;
	"line": number;
	"column": number;
	"source": "ts" | "eslint";
	"code": string | number | null;
	"severity": string;
	"message": string;
}

/** What history's plugin answers (`_history.problems`). */
interface Compared {
	"projects": {
		"project": string;
		"checked": { "file": string; "now": Omit<Problem, "file" | "source">[] | null; "head": Omit<Problem, "file" | "source">[] | null }[];
		"unchecked": string[];
		"beyond": number;
	}[];
	"outside": string[];
	/** What failed, when the plugin couldn't compare. */
	"error"?: string;
}

/** The problems `now` has that `head` hasn't (added), and those `head` has that `now` hasn't (cleared), as multisets: a
 *  problem is the same one when its file, source, code and message are. */
export function problemsDelta(head: Problem[], now: Problem[]): { "added": Problem[]; "cleared": Problem[]; "unchanged": number } {
	const key = (problem: Problem): string => JSON.stringify([problem.file, problem.source, problem.code, problem.message]);
	const before = new Map<string, Problem[]>();

	for (const problem of head) {
		before.set(key(problem), [...before.get(key(problem)) ?? [], problem]);
	}

	const added: Problem[] = [];
	let unchanged = 0;

	for (const problem of now) {
		const same = before.get(key(problem));

		if (same !== undefined && same.length > 0) {
			same.shift();
			unchanged += 1;
		} else {
			added.push(problem);
		}
	}

	return { "added": added, "cleared": [...before.values()].flat(), "unchanged": unchanged };
}

/** TypeScript's side: what history's plugin says of the changed files and their importers, now and at HEAD. */
async function typescriptProblems(vscode: typeof vscodeApi, heads: Map<GitFileChange, string | null>, depth: number, limit: number): Promise<{ "head": Problem[]; "now": Problem[]; "compared"?: Compared }> {
	const ask = async (): Promise<Compared | undefined> => (await Promise.resolve(vscode.commands.executeCommand<{ "body"?: Compared } | undefined>("typescript.tsserverRequest", "_history.problems", {
		"files": Object.fromEntries([...heads].map(([change, text]) => [`${ROOT}/${change.path}`, text])),
		"depth": depth,
		"limit": limit
	})).catch(() => undefined))?.body;
	let compared = heads.size === 0 ? undefined : await ask();

	// A server just started doesn't know the request until it makes a project (the plugin registers it then), and holds
	// no project for a file it's still opening: it's asked again, a little later.
	for (let tried = 1; heads.size > 0 && tried < TRIES && (compared === undefined || (compared.error === undefined && compared.projects.length === 0)); tried += 1) {
		await new Promise((resolve) => {
			setTimeout(resolve, TRY_MS);
		});
		compared = await ask();
	}
	const head: Problem[] = [];
	const now: Problem[] = [];

	for (const { checked } of compared?.projects ?? []) {
		for (const file of checked) {
			head.push(...(file.head ?? []).map((problem) => ({ ...problem, "file": relative(file.file), "source": "ts" as const })));
			now.push(...(file.now ?? []).map((problem) => ({ ...problem, "file": relative(file.file), "source": "ts" as const })));
		}
	}

	return { "head": head, "now": now, "compared": compared };
}

/** ESLint's side: each changed file linted at its path, as it is now and as HEAD had it. */
async function eslintProblems(vscode: typeof vscodeApi, heads: Map<GitFileChange, string | null>): Promise<{ "head": Problem[]; "now": Problem[]; "linted": string[] }> {
	const head: Problem[] = [];
	const now: Problem[] = [];
	const linted: string[] = [];

	for (const [change, text] of heads) {
		const uri = vscode.Uri.file(`${ROOT}/${change.path}`);
		const ask = async (of?: string): Promise<Omit<Problem, "file" | "source">[] | undefined> => Promise.resolve(vscode.commands.executeCommand<Omit<Problem, "file" | "source">[] | undefined>("_eslint.problems", uri, of)).catch(() => undefined);
		// (a deleted file: none now, and HEAD's can't be linted without its document)
		const after = change.status === "D" ? undefined : await ask();

		if (after !== undefined) {
			linted.push(change.path);
			now.push(...after.map((problem) => ({ ...problem, "file": change.path, "source": "eslint" as const })));
			head.push(...(text === null ? [] : await ask(text) ?? []).map((problem) => ({ ...problem, "file": change.path, "source": "eslint" as const })));
		}
	}

	return { "head": head, "now": now, "linted": linted };
}

export function installCodeProblems(vscode: typeof vscodeApi, hub: Hub, git: GitReader, projects: TypeScriptProjects): void {
	serve(hub, "code.problems", async (args) => {
		const { paths, depth, limit } = (args ?? {}) as { "paths"?: unknown; "depth"?: unknown; "limit"?: unknown };
		const only = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string").map((path) => path.replace(/^\/workspace\//u, "").replace(/\/$/u, "")) : undefined;
		const changes = (await git.status()).files.filter((change) => CODE.test(change.path) && (only === undefined || only.some((path) => change.path === path || change.path.startsWith(path + "/"))));
		const heads = new Map<GitFileChange, string | null>();

		for (const change of changes) {
			heads.set(change, change.status === "A" ? null : (await git.file(change.path)).head);
		}

		// (the projects told first, so they hold the files made since: ts-projects.ts)
		await projects.refresh();

		// (each one's symbols asked, so the TypeScript server holds its project: opening a document doesn't hand it to the
		// server, a language feature's request does)
		await Promise.all(changes.filter((change) => change.status !== "D").map(async (change) => Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", vscode.Uri.file(`${ROOT}/${change.path}`))).then(() => undefined, () => undefined)));

		const typescript = await typescriptProblems(vscode, heads, depth === 0 ? 0 : 1, typeof limit === "number" && limit > 0 ? limit : 100);
		const eslint = await eslintProblems(vscode, heads);
		const { added, cleared, unchanged } = problemsDelta([...typescript.head, ...eslint.head], [...typescript.now, ...eslint.now]);
		const compared = typescript.compared?.projects ?? [];

		return {
			"added": added.slice(0, LISTED),
			"cleared": cleared.slice(0, LISTED),
			"counts": { "added": added.length, "cleared": cleared.length, "unchanged": unchanged },
			"checked": {
				"changed": changes.map(({ path, status }) => `${status} ${path}`),
				"typescript": [...new Set(compared.flatMap(({ checked }) => checked.map(({ file }) => relative(file))))].sort((left, right) => left.localeCompare(right)),
				"eslint": eslint.linted
			},
			// What it didn't look at, so an empty `added` isn't read as more than it is.
			"unchecked": {
				...typescript.compared === undefined && changes.length > 0 ? { "typescript": "the TypeScript server didn't answer (still starting, or no project holds these files)" } : {},
				...typescript.compared?.error === undefined ? {} : { "typescript": `the comparison failed: ${typescript.compared.error}` },
				"importers": compared.flatMap(({ "unchecked": over }) => over.map(relative)),
				"furtherImporters": compared.reduce((total, { beyond }) => total + beyond, 0),
				"noProject": (typescript.compared?.outside ?? []).map(relative)
			}
		};
	});
}
