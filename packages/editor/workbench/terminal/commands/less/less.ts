/** The terminal's `less` and `more` (commands/more): what they'd page, whole. The terminal scrolls, and a pager would need keys it doesn't get. */
import type { CommandHost, Handler } from "../../catalog";

export const pager = (name: string) => (_host: CommandHost): Handler => async (config, ctx) => {
	const files = config.get("files") as string[];

	if (files.length === 0) {
		const piped = String(ctx.stdin);

		return piped === ""
			? { "stdout": "", "stderr": `${name}: missing filename\n`, "exitCode": 1 }
			: { "stdout": piped, "stderr": "", "exitCode": 0 };
	}

	const read = await Promise.all(files.map(async (file) => ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file)).then(
		(text) => ({ "out": String(text), "error": "" }),
		() => ({ "out": "", "error": `${name}: ${file}: No such file or directory\n` })
	)));
	const errors = read.map((each) => each.error).join("");

	return { "stdout": read.map((each) => each.out).join(""), "stderr": errors, "exitCode": errors === "" ? 0 : 1 };
};

export const create = pager("less");
