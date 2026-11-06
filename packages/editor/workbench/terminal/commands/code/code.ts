/**
 * The terminal's `code`: a file into the editor from a prompt, as VS Code's own does. A file that isn't there opens unsaved at that
 * path, as `code new.ts` does; a folder is shown in the Explorer, as the window it would open already has it.
 */
import type { ResolvedCommandContext } from "just-bash/browser";
import type { CommandHost, CommandResult, Handler } from "../../catalog";

const TARGET = /^(?<path>.*?)(?::(?<line>\d+)(?::(?<column>\d+))?)?$/u;

/** `paths`, opened where they are from `ctx.cwd`; what couldn't be is said. */
export async function openPaths(api: CommandHost["api"], paths: string[], ctx: ResolvedCommandContext, goto = false): Promise<CommandResult> {
	const errors: string[] = [];

	for (const each of paths) {
		const { path = each, line, column } = (goto ? TARGET.exec(each)?.groups : undefined) ?? {};
		const uri = api.Uri.file(ctx.fs.resolvePath(ctx.cwd, path));
		const at = line === undefined ? undefined : new api.Position(Number(line) - 1, Number(column ?? 1) - 1);
		const options = { "preview": false, ...at === undefined ? {} : { "selection": new api.Range(at, at) } };

		try {
			const kind = await api.workspace.fs.stat(uri).then((stat) => stat.type, () => undefined);

			if (kind === undefined) {
				await api.commands.executeCommand("vscode.open", uri.with({ "scheme": "untitled" }), options);
			} else if ((kind & api.FileType.Directory) === 0) {
				await api.commands.executeCommand("vscode.open", uri, options);
			} else {
				await api.commands.executeCommand("revealInExplorer", uri);
			}
		} catch (error) {
			errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	return { "stdout": "", "stderr": errors.join(""), "exitCode": errors.length === 0 ? 0 : 1 };
}

export function create({ api }: CommandHost): Handler {
	return async (config, ctx) => openPaths(api, config.get("paths") as string[], ctx, config.get("goto") === true);
}
