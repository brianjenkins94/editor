/**
 * pnpm and yarn: npm, in their words (commands/npm), so a line someone's used to typing, or a project's README, does what it says. What
 * they call differently is said in npm's words, and any other word is a script by its name, as both take it (`pnpm dev`).
 */
import type { CommandFactory } from "./catalog";
import { inShell, quote } from "./commands/npm/npm";

const SAME = ["install", "i", "ci", "uninstall", "ls", "list", "run", "run-script", "start", "stop", "test", "restart", "exec", "x", "version", "--help", "-h"];
const THEIR_WORDS: Record<string, string[]> = { "add": ["install"], "remove": ["uninstall"], "rm": ["uninstall"], "un": ["uninstall"], "dlx": ["exec"] };

/** A flag npm spells otherwise. */
const THEIR_FLAGS: Record<string, string> = { "--dev": "-D", "--save-dev": "-D", "--save": "-S" };

/** The command for `name`, whose word alone means `alone` in npm's. */
export const npmWords = (alone: string[]): CommandFactory => ({ session }) => async (config, ctx) => {
	const [first, ...rest] = config.get("args") as string[];
	const said = first === undefined
		? alone
		: [...THEIR_WORDS[first] ?? (SAME.includes(first) ? [first] : ["run", first]), ...rest.map((word) => THEIR_FLAGS[word] ?? word)];

	return inShell(session, ["npm", ...said].map(quote).join(" "), ctx);
};
