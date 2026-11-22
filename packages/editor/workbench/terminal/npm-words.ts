import type { CommandFactory } from "./catalog";
import { inShell, quote } from "./commands/npm/npm";

const SAME = ["install", "i", "ci", "uninstall", "ls", "list", "run", "run-script", "start", "stop", "test", "restart", "exec", "x", "version", "--help", "-h"];
const THEIR_WORDS: Record<string, string[]> = { "add": ["install"], "remove": ["uninstall"], "rm": ["uninstall"], "un": ["uninstall"], "dlx": ["exec"] };

const THEIR_FLAGS: Record<string, string> = { "--dev": "-D", "--save-dev": "-D", "--save": "-S" };

export const npmWords = (alone: string[]): CommandFactory => ({ session }) => async (config, ctx) => {
	const [first, ...rest] = config.get("args") as string[];
	const said = first === undefined
		? alone
		: [...THEIR_WORDS[first] ?? (SAME.includes(first) ? [first] : ["run", first]), ...rest.map((word) => THEIR_FLAGS[word] ?? word)];

	return inShell(session, ["npm", ...said].map(quote).join(" "), ctx);
};
