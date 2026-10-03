/**
 * TypeScript Playground links, opened as projects — and written, to share one. Swap the host of any playground link for
 * ours and the same hash opens here as a real workspace. The shell decodes it (it owns the URL) and hands the files to the
 * app as a project load, the same way a GitHub repo arrives. Share writes the workspace back out as a v2 link, which the
 * playground itself opens too.
 *
 * The formats, as the playground writes them:
 *   • `#code/v2/<lz>` (Playground v2): lz-string JSON `{ version, files: { "/workspace/…": text }, activeFile, selection }`
 *     — a whole project, tsconfig.json included.
 *   • `#code/<lz>` (the classic playground): one file's source, lz-string compressed; its compiler options ride the query
 *     string (`?target=4&strict=false`), as the ones that differ from the playground's defaults.
 *   • `#src=<text>`: one file's source, URI-encoded.
 */
import LZString from "lz-string";

/** A decoded playground project, ready to open: absolute workspace paths and the editors to focus. */
export interface PlaygroundProject {
	"files": { "path": string; "contents": string }[];
	"openEditors": string[];
}

const WORKSPACE = "/workspace/";

/** A link's lz-string payload, decoded; undefined when it isn't one (lz-string answers null, or "", or throws). */
function decode(payload: string): string | undefined {
	try {
		const text = LZString.decompressFromEncodedURIComponent(payload);

		return typeof text === "string" && text !== "" ? text : undefined;
	} catch {
		return undefined;
	}
}

// The classic playground's defaults (its sandbox's getDefaultSandboxCompilerOptions), so a snippet checks as it did
// there; the query string carries only what differs.
const CLASSIC_DEFAULTS: Record<string, unknown> = {
	"strict": true,
	"target": "ES2017",
	"module": "ESNext",
	"moduleResolution": "bundler",
	"jsx": "react",
	"esModuleInterop": true,
	"experimentalDecorators": true,
	"emitDecoratorMetadata": true,
	"declaration": true,
	"noImplicitReturns": true,
	"allowUnreachableCode": false,
	"allowUnusedLabels": false,
	"useDefineForClassFields": false
};

// The query string writes enum options as TypeScript's numeric enum values.
const ENUM_OPTIONS: Record<string, Record<string, string>> = {
	"target": { "0": "ES3", "1": "ES5", "2": "ES2015", "3": "ES2016", "4": "ES2017", "5": "ES2018", "6": "ES2019", "7": "ES2020", "8": "ES2021", "9": "ES2022", "10": "ES2023", "11": "ES2024", "99": "ESNext" },
	"module": { "0": "None", "1": "CommonJS", "2": "AMD", "3": "UMD", "4": "System", "5": "ES2015", "6": "ES2020", "7": "ES2022", "99": "ESNext", "100": "Node16", "101": "Node18", "199": "NodeNext", "200": "Preserve" },
	"jsx": { "1": "preserve", "2": "react", "3": "react-native", "4": "react-jsx", "5": "react-jsxdev" },
	"moduleResolution": { "1": "classic", "2": "node10", "3": "node16", "99": "nodenext", "100": "bundler" },
	"moduleDetection": { "1": "legacy", "2": "auto", "3": "force" },
	"newLine": { "0": "crlf", "1": "lf" }
};

// Query parameters that are the playground's own, not compiler options.
const PLAYGROUND_PARAMS = new Set(["ts", "filetype", "useJavaScript", "install-plugin", "ssl", "ssc", "pln", "pc", "q", "debug"]);

/** The compiler options a classic link's query string sets, over the playground's defaults. */
function classicCompilerOptions(query: URLSearchParams, javascript: boolean): Record<string, unknown> {
	const options: Record<string, unknown> = { ...CLASSIC_DEFAULTS };

	if (javascript) {
		options["allowJs"] = true;
		options["checkJs"] = true;
	}

	for (const [key, raw] of [...query].filter(([name]) => !PLAYGROUND_PARAMS.has(name) && /^[a-zA-Z]+$/u.test(name))) {
		if (raw === "true" || raw === "false") {
			options[key] = raw === "true";
		} else if (key === "jsx" && raw === "0") {
			delete options[key]; // JsxEmit.None: tsconfig spells it by leaving the option out
		} else if (ENUM_OPTIONS[key] !== undefined) {
			options[key] = ENUM_OPTIONS[key][raw] ?? raw;
		} else if (/^\d+$/u.test(raw)) {
			options[key] = Number(raw);
		} else {
			options[key] = raw;
		}
	}

	return options;
}

/** A one-file classic project: the source under the playground's file name, and a tsconfig with its options. */
function classicProject(source: string, query: URLSearchParams): PlaygroundProject {
	const javascript = query.get("useJavaScript") === "true" || query.get("filetype") === "js";
	let filetype = javascript ? "js" : "ts";

	if (query.get("filetype") === "d.ts") {
		filetype = "d.ts";
	}

	const compilerOptions = classicCompilerOptions(query, javascript);
	// The playground names its file `input.<ext>`, with an `x` when JSX is on (except a .d.ts).
	const extension = compilerOptions["jsx"] !== undefined && filetype !== "d.ts" ? filetype + "x" : filetype;
	const path = WORKSPACE + "input." + extension;

	return {
		"files": [
			{ "path": WORKSPACE + "tsconfig.json", "contents": JSON.stringify({ "compilerOptions": compilerOptions }, undefined, 2) + "\n" },
			{ "path": path, "contents": source }
		],
		"openEditors": [path]
	};
}

/** A Playground v2 project: its files as they are, kept to /workspace. */
function v2Project(json: string): PlaygroundProject | undefined {
	let state: unknown;

	try {
		state = JSON.parse(json);
	} catch {
		return undefined;
	}

	const { activeFile, files } = (state ?? {}) as { "activeFile"?: unknown; "files"?: unknown };

	if (typeof files !== "object" || files === null) {
		return undefined;
	}

	const entries = Object.entries(files).filter((entry): entry is [string, string] => {
		const [path, contents] = entry;

		return typeof contents === "string" && path.startsWith(WORKSPACE) && !path.split("/").some((segment) => segment === ".." || segment === ".");
	});

	if (entries.length === 0) {
		return undefined;
	}

	const paths = entries.map(([path]) => path);

	return {
		"files": entries.map(([path, contents]) => ({ "path": path, "contents": contents })),
		"openEditors": [typeof activeFile === "string" && paths.includes(activeFile) ? activeFile : paths.find((path) => !path.endsWith(".json")) ?? paths[0]]
	};
}

/** The project a playground link's hash (and, for a classic link, its query string) describes; undefined when the hash
 *  isn't a playground link. */
export function parsePlaygroundLink(hash: string, search = ""): PlaygroundProject | undefined {
	const fragment = hash.replace(/^#/u, "");
	const query = new URLSearchParams(search);

	if (fragment.startsWith("code/v2/")) {
		const json = decode(fragment.slice("code/v2/".length));

		return json === undefined ? undefined : v2Project(json);
	}

	if (fragment.startsWith("code/")) {
		const source = decode(fragment.slice("code/".length));

		return source === undefined ? undefined : classicProject(source, query);
	}

	if (fragment.startsWith("src=")) {
		try {
			return classicProject(decodeURIComponent(fragment.slice("src=".length)), query);
		} catch {
			return undefined; // malformed escape
		}
	}

	return undefined;
}

/** Where the cursor was, as the playground records it: Monaco's 1-based lines and columns. */
export interface PlaygroundSelection {
	"positionLineNumber": number;
	"positionColumn": number;
	"selectionStartLineNumber": number;
	"selectionStartColumn": number;
}

/** A workspace to share: its files, and the editor in front. */
export interface SharedWorkspace {
	"files": { "path": string; "bytes": Uint8Array }[];
	"activeFile"?: string;
	"selection"?: PlaygroundSelection;
}

/** A Playground v2 link to `workspace` on `base` (this page's address). A link carries text, so binary files are left out
 *  and named in `skipped`. */
export function playgroundLink(base: string, workspace: SharedWorkspace): { "url": string; "skipped": string[] } {
	const decoder = new TextDecoder("utf-8", { "fatal": true });
	const files: Record<string, string> = {};
	const skipped: string[] = [];

	for (const { bytes, path } of workspace.files.filter((file) => file.path.startsWith(WORKSPACE))) {
		try {
			if (bytes.includes(0)) {
				throw new TypeError("binary"); // a NUL byte means binary, as git judges it
			}

			files[path] = decoder.decode(bytes);
		} catch {
			skipped.push(path);
		}
	}

	const active = workspace.activeFile !== undefined && Object.hasOwn(files, workspace.activeFile) ? workspace.activeFile : undefined;
	const state = { "version": 2, "activeFile": active, "files": files, "selection": active === undefined ? undefined : workspace.selection };

	return { "url": base + "#code/v2/" + LZString.compressToEncodedURIComponent(JSON.stringify(state)), "skipped": skipped };
}
