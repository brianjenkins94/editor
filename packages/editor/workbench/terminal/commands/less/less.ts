/**
 * The terminal's `less` (and `more`, ../more): print the files, or what's piped in. A pager pages a screen at a time;
 * this terminal scrolls back on its own, so printing it all is what `less file` and `… | less` should do here.
 */
import type { Handler } from "../../catalog";

/** stdin's bytes (just-bash hands them over as latin1 characters, in a string) as UTF-8 text. */
const text = (stdin: unknown): string => new TextDecoder().decode(Uint8Array.from(typeof stdin === "string" ? stdin : "", (character) => character.charCodeAt(0)));

export function pager(name: string): Handler {
	return async (config, ctx) => {
		const files = config.get("files") as string[];

		if (files.length === 0) {
			return { "stdout": text(ctx.stdin), "stderr": "", "exitCode": 0 };
		}

		let stdout = "";
		const errors: string[] = [];

		for (const file of files) {
			try {
				stdout += await ctx.fs.readFile(file.startsWith("/") ? file : `${ctx.cwd}/${file}`);
			} catch {
				errors.push(`${name}: ${file}: No such file or directory`);
			}
		}

		return { "stdout": stdout, "stderr": errors.map((error) => error + "\n").join(""), "exitCode": errors.length === 0 ? 0 : 1 };
	};
}

export function create(): Handler {
	return pager("less");
}
