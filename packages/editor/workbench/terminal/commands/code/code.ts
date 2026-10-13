/**
 * The terminal's `code` (and `open`, ../open): what VS Code's own `code` does from a desktop terminal — open each file in
 * the editor, at a line when it's given as `file:line[:column]` (as compilers and test runners print them), a file that
 * doesn't exist yet as a new one that saves there, and a folder revealed in the Explorer.
 */
import type { CommandHost, Handler } from "../../catalog";

/** POSIX resolve of `path` against `base`. */
function resolve(base: string, path: string): string {
	const parts: string[] = [];

	for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	return "/" + parts.join("/");
}

/** The opener, named `name` (`code`, `open`); `urls` opens a URL in the browser too (`open https://…`). */
export function opener(name: string, { api }: CommandHost, { urls = false }: { "urls"?: boolean } = {}): Handler {
	return async (config, ctx) => {
		const targets = config.get("targets") as string[];
		const errors: string[] = [];

		if (targets.length === 0) {
			return { "stdout": "", "stderr": `${name}: what should it open? (${name} --help)\n`, "exitCode": 1 };
		}

		for (const target of targets) {
			if (urls && /^https?:\/\//u.test(target)) {
				await api.env.openExternal(api.Uri.parse(target));
			} else {
				// `file:line[:column]`, unless the whole thing is a file's name.
				let path = resolve(ctx.cwd, target);
				let at: { "line": number; "column": number } | undefined;
				let stat = await ctx.fs.stat(path).catch(() => undefined);
				const position = /^(.*?):(\d+)(?::(\d+))?$/u.exec(target);

				if (stat === undefined && position !== null) {
					path = resolve(ctx.cwd, position[1]);
					at = { "line": Number(position[2]), "column": Number(position[3] ?? 1) };
					stat = await ctx.fs.stat(path).catch(() => undefined);
				}

				const uri = api.Uri.file(path);

				try {
					if (stat?.isDirectory === true) {
						await api.commands.executeCommand("revealInExplorer", uri);
					} else {
						// A file that isn't there yet opens as a new one, saved to that path when it's saved.
						const document = await api.workspace.openTextDocument(stat === undefined ? uri.with({ "scheme": "untitled" }) : uri);
						const selection = at === undefined ? undefined : new api.Range(at.line - 1, at.column - 1, at.line - 1, at.column - 1);

						await api.window.showTextDocument(document, { "preview": false, ...selection === undefined ? {} : { "selection": selection } });
					}
				} catch (error) {
					errors.push(`${name}: ${target}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}

		return { "stdout": "", "stderr": errors.map((error) => error + "\n").join(""), "exitCode": errors.length === 0 ? 0 : 1 };
	};
}

export function create(host: CommandHost): Handler {
	return opener("code", host);
}
