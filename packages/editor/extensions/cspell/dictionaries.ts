/**
 * The cspell dictionaries the editor loads: cspell's own defaults for code (cspell-bundled-dicts' default config) — English,
 * company and software terms everywhere; TypeScript, Node and npm words in code and JSON; HTML and CSS words where those
 * are written. Each is a file of its @cspell package, served beside the language server (build.ts `cspellDict`), fetched
 * into its file system (server-host.ts) and enabled for its languages (server-node.ts). A repository's own words
 * (a cspell config's) aren't read: the server checks with these alone.
 */
export interface Dictionary {
	/** cspell's name for it. */
	"name": string;
	/** The package it's in, and its file there. */
	"package": string;
	"file": string;
	/** The languages it's for (VS Code's ids); none, every one. */
	"languages"?: string[];
}

const CODE = ["javascript", "javascriptreact", "typescript", "typescriptreact"];

export const DICTIONARIES: Dictionary[] = [
	{ "name": "en_US", "package": "@cspell/dict-en_us", "file": "en_US.trie.gz" },
	{ "name": "companies", "package": "@cspell/dict-companies", "file": "dict/companies.txt" },
	{ "name": "softwareTerms", "package": "@cspell/dict-software-terms", "file": "dict/softwareTerms.txt.gz" },
	{ "name": "coding-compound-terms", "package": "@cspell/dict-software-terms", "file": "dict/coding-compound-terms.txt" },
	{ "name": "computing-acronyms", "package": "@cspell/dict-software-terms", "file": "dict/computing-acronyms.txt" },
	{ "name": "software-tools", "package": "@cspell/dict-software-terms", "file": "dict/software-tools.txt" },
	{ "name": "web-services", "package": "@cspell/dict-software-terms", "file": "dict/webServices.txt" },
	{ "name": "typescript", "package": "@cspell/dict-typescript", "file": "dict/typescript.txt", "languages": [...CODE, "html"] },
	{ "name": "node", "package": "@cspell/dict-node", "file": "dict/node.txt", "languages": [...CODE, "json", "jsonc"] },
	{ "name": "npm", "package": "@cspell/dict-npm", "file": "dict/npm.txt", "languages": [...CODE, "json", "jsonc", "markdown", "html"] },
	{ "name": "html", "package": "@cspell/dict-html", "file": "dict/html.txt.gz", "languages": ["html", "javascriptreact", "typescriptreact", "markdown"] },
	{ "name": "css", "package": "@cspell/dict-css", "file": "dict/css.txt", "languages": ["css", "less", "scss", "html", "javascriptreact", "typescriptreact"] }
];

/** Its file's name where it's served and in the server's file system: its name, with its file's extension. */
export function servedName(dictionary: Dictionary): string {
	const base = dictionary.file.slice(dictionary.file.lastIndexOf("/") + 1);

	return dictionary.name + base.slice(base.indexOf("."));
}
