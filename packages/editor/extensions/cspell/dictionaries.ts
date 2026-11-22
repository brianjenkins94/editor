export interface Dictionary {
	"name": string;
	"package": string;
	"file": string;
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

export function servedName(dictionary: Dictionary): string {
	const base = dictionary.file.slice(dictionary.file.lastIndexOf("/") + 1);

	return dictionary.name + base.slice(base.indexOf("."));
}
