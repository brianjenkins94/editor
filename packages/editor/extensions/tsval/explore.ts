import type { WorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import type { Explored, Ordering } from "./debug-protocol";
import { loadEffectivePolicy } from "@brianjenkins94/editor-api/policy";
import { logger } from "@brianjenkins94/util/logger";
import { EMPTY_POLICY, given } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { startWorker } from "./debug-adapter";

const log = logger({ "source": "tsval" });

const MAX_RUNS = 100;

async function exploreProgram(runtime: WorkspaceRuntime, program: vscode.Uri, maxRuns = MAX_RUNS): Promise<Explored> {
	const source = vscode.workspace.textDocuments.find((document) => document.uri.toString() === program.toString())?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(program));
	const policy = await loadEffectivePolicy().catch(() => EMPTY_POLICY);
	const argv = given(policy, {
		"program": vscode.workspace.asRelativePath(program, false)
	}, "process.argv")?.values.find((each): each is string[] => Array.isArray(each));
	let settle: { "resolve": (explored: Explored) => void; "reject": (reason: Error) => void } | undefined;
	const explored = new Promise<Explored>((resolve, reject) => {
		settle = { "resolve": resolve, "reject": reject };
	});
	const worker = startWorker(runtime, undefined, (event) => {
		if (event.type === "explored") {
			settle?.resolve(event.explored);
		}
	}, (message) => {
		settle?.reject(new Error(`the debug worker failed: ${message}`));
	});
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		worker.send({
			"type": "explore",
			"source": source,
			"fileName": program.path,
			"policy": policy,
			"args": argv ?? [],
			"eventLoop": {
				"now": Date.now(),
				"seed": Math.floor(Math.random() * 2 ** 32)
			},
			"maxRuns": maxRuns,
			...worker.buffer === undefined
				? {}
				: { "workspace": worker.buffer }
		});

		return await Promise.race([
			explored,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error("exploring took over 2 minutes"));
				}, 120_000);
			})
		]);
	} finally {
		clearTimeout(timer);
		worker.close();
	}
}

function ordinal(count: number): string {
	const tens = count % 100;
	const suffix = tens >= 11 && tens <= 13
		? "th"
		: ({ "1": "st", "2": "nd", "3": "rd" } as Record<string, string>)[String(count % 10)] ?? "th";

	return `${String(count)}${suffix}`;
}

function placeIn(index: number, total: number): string {
	if (index === 0) {
		return "first";
	}

	return index === total - 1
		? "last"
		: ordinal(index + 1);
}

function didAt(outcome: Ordering, file: string, line: number, outcomes: Ordering[]): string {
	const printed = outcome.output.flatMap((each, index) => (each.file === file && each.line === line
		? [`prints ${JSON.stringify(each.text)}${outcome.output.length === 1
				? ""
				: ` ${placeIn(index, outcome.output.length)}`}`]
		: []));
	const threw = outcome.crash !== undefined && (outcome.crash.file ?? "") === file && outcome.crash.line === line
		? [`throws ${JSON.stringify(outcome.crash.message)}`]
		: [];
	const did = [
		...printed,
		...threw
	];

	if (did.length > 0) {
		return did.join(", then ");
	}

	return outcomes.some((other) => other.output.some((each) => each.file === file && each.line === line))
		? "prints nothing"
		: "doesn't throw";
}

function orderingsNamed(indices: number[]): string {
	const numbers = indices.map((index) => String(index + 1));

	return numbers.length === 1
		? `ordering ${numbers[0]}`
		: `orderings ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

interface Exploring { "program": vscode.Uri; "explored": Explored }

interface Said { "exploring": Exploring; "at"?: { "file": string; "line": number } }

function pathOf(outcome: Ordering): string {
	const path = outcome.path.join(" → ");

	if (path === "") {
		return "no choice made";
	}

	return path.length > 80
		? `${path.slice(0, 79)}…`
		: path;
}

export function registerExplore(context: vscode.ExtensionContext, runtime: WorkspaceRuntime): void {
	const diagnostics = vscode.languages.createDiagnosticCollection("orderings");
	const saidOf = new WeakMap<vscode.Diagnostic, Said>();
	const placed = new Map<string, vscode.Uri[]>();

	const clear = (program: string): void => {
		for (const uri of placed.get(program) ?? []) {
			diagnostics.delete(uri);
		}

		placed.delete(program);
	};

	const say = (exploring: Exploring): void => {
		const { program, explored } = exploring;
		const places = new Map<string, { "file": string; "line": number }>();

		for (const outcome of explored.outcomes) {
			for (const { file, line } of [
				...outcome.output,
				...outcome.crash?.line === undefined
					? []
					: [
							{ "file": outcome.crash.file ?? program.path, "line": outcome.crash.line }
						]
			]) {
				places.set(`${file}:${String(line)}`, { "file": file, "line": line });
			}
		}

		const byFile = new Map<string, vscode.Diagnostic[]>();
		const summary = `${String(explored.outcomes.length)} ways it ends, in ${String(explored.runs)} run${explored.runs === 1
			? ""
			: "s"}${explored.complete ? "" : ", cut short"}`;
		const add = (file: string, diagnostic: vscode.Diagnostic, line?: number): void => {
			diagnostic.source = "orderings";
			saidOf.set(diagnostic, {
				"exploring": exploring,
				...line === undefined
					? {}
					: {
							"at": { "file": file, "line": line }
						}
			});
			byFile.set(file, [
				...byFile.get(file) ?? [],
				diagnostic
			]);
		};

		for (const { file, line } of places.values()) {
			const did = explored.outcomes.map((outcome) => didAt(outcome, file, line, explored.outcomes));
			const ways = new Map<string, number[]>();

			did.forEach((each, index) => {
				ways.set(each, [
					...ways.get(each) ?? [],
					index
				]);
			});

			if (ways.size > 1) {
				const said = [...ways].map(([what, indices]) => `${orderingsNamed(indices)}: ${what}`).join("; ");
				const threw = explored.outcomes.some((outcome) => outcome.crash?.line === line && (outcome.crash.file ?? program.path) === file);

				add(file, new vscode.Diagnostic(new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER), `What this line does depends on the order of events. In ${said}. (${summary})`, threw ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information), line);
			}
		}

		if (byFile.size === 0) {
			add(program.path, new vscode.Diagnostic(new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER), `How this file ends depends on the order of events: ${explored.outcomes.map((outcome, index) => `${orderingsNamed([index])} ${outcome.crash === undefined
				? `prints ${String(outcome.output.length)} line${outcome.output.length === 1
					? ""
					: "s"}`
				: `throws ${JSON.stringify(outcome.crash.message)}`}`).join("; ")}. (${summary})`, vscode.DiagnosticSeverity.Information));
		}

		clear(program.toString());

		const uris = [
			...byFile.keys()
		].map((file) => program.with({ "path": file }));

		for (const uri of uris) {
			diagnostics.set(uri, byFile.get(uri.path));
		}

		placed.set(program.toString(), uris);
	};

	context.subscriptions.push(
		diagnostics,
		vscode.commands.registerCommand("tsval.exploreOrderings", async (target?: vscode.Uri): Promise<Explored | { "error": string } | undefined> => {
			const program = target instanceof vscode.Uri
				? target
				: vscode.window.activeTextEditor?.document.uri;

			if (program === undefined) {
				return undefined;
			}

			const name = program.path.split("/").pop() ?? program.path;

			try {
				const explored = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Notification, "title": `Exploring the orderings of ${name}…` }, async () => log.span("editor.extensions.tsval.explore.orderings", {
					"path": vscode.workspace.asRelativePath(program, false)
				}, async (span) => {
					const found = await exploreProgram(runtime, program);

					span.end({ "runs": found.runs, "count": found.outcomes.length });

					return found;
				}));
				const runs = `${String(explored.runs)} run${explored.runs === 1
					? ""
					: "s"}${explored.complete ? "" : ", cut short"}`;

				if (explored.outcomes.length <= 1) {
					clear(program.toString());
					void vscode.window.showInformationMessage(`No race in ${name}: every ordering ends the same way (${runs}).`);

					return explored;
				}

				say({ "program": program, "explored": explored });
				void vscode.window.showInformationMessage(`${name} can end ${String(explored.outcomes.length)} ways (${runs}): said on the lines that differ, each ordering debugged from their lightbulb.`);

				return explored;
			} catch (error) {
				const said = `Couldn't explore the orderings of ${name}: ${error instanceof Error
					? error.message
					: String(error)}`;

				void vscode.window.showErrorMessage(said);

				return { "error": said };
			}
		}),
		vscode.commands.registerCommand("tsval.debugOrdering", async (program: vscode.Uri, explored: Explored, index: number) => {
			const name = program.path.split("/").pop() ?? program.path;

			await vscode.debug.startDebugging(undefined, {
				"type": "tsval",
				"request": "launch",
				"name": `${name}, ordering ${String(index + 1)} of ${String(explored.outcomes.length)}`,
				"program": program.path,
				"eventLoop": { ...explored.eventLoop, "schedule": explored.outcomes[index].schedule }
			});
		}),
		vscode.languages.registerCodeActionsProvider([
			{ "scheme": "file" }
		], {
			"provideCodeActions": (_document, _range, { "diagnostics": here }) => {
				const said = here.map((diagnostic) => saidOf.get(diagnostic)).find((each) => each !== undefined);

				if (said === undefined) {
					return [];
				}

				const { exploring, at } = said;

				return exploring.explored.outcomes.map((outcome, index) => {
					const title = `Debug ordering ${String(index + 1)}${at === undefined
						? ""
						: `, where it ${didAt(outcome, at.file, at.line, exploring.explored.outcomes)}`} (${pathOf(outcome)})`;
					const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

					action.command = {
						"title": title,
						"command": "tsval.debugOrdering",
						"arguments": [exploring.program, exploring.explored, index]
					};
					action.diagnostics = here.filter((diagnostic) => saidOf.get(diagnostic)?.exploring === exploring);

					return action;
				});
			}
		}, {
			"providedCodeActionKinds": [vscode.CodeActionKind.QuickFix]
		}),
		vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
			if (contentChanges.length === 0) {
				return;
			}

			for (const [program, uris] of placed) {
				if (program === document.uri.toString() || uris.some((uri) => uri.toString() === document.uri.toString())) {
					clear(program);
				}
			}
		})
	);
}
