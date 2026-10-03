/**
 * TypeScript Playground links, opened as projects. Swap the host of any playground link for ours and the same hash opens
 * here as a real workspace. The shell decodes it (it owns the URL) and hands the files to the app as a project load, the
 * same way a GitHub repo arrives.
 *
 * The formats, as the playground writes them:
 *   • `#code/v2/<lz>` (Playground v2): lz-string JSON `{ version, files: { "/workspace/…": text }, activeFile, selection }`
 *     — a whole project, tsconfig.json included.
 *   • `#code/<lz>` (the classic playground): one file's source, lz-string compressed; its compiler options ride the query
 *     string (`?target=4&strict=false`), as the ones that differ from the playground's defaults.
 *   • `#src=<text>`: one file's source, URI-encoded.
 *
 * lz-string's `decompressFromEncodedURIComponent` is reimplemented below (the format is small and fixed) rather than
 * pulled in as a dependency.
 */

/** A decoded playground project, ready to open: absolute workspace paths and the editors to focus. */
export interface PlaygroundProject {
	"files": { "path": string; "contents": string }[];
	"openEditors": string[];
}

const WORKSPACE = "/workspace/";

// lz-string's URI-safe alphabet: each character carries 6 bits.
const URI_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";

/** lz-string's `decompressFromEncodedURIComponent`: undefined when the input isn't a valid stream. */
export function decompressFromEncodedURIComponent(input: string): string | undefined {
	// A `+` that went through form decoding comes back as a space.
	const encoded = input.replace(/ /gu, "+");

	if (encoded.length === 0) {
		return undefined;
	}

	const valueAt = (index: number): number => URI_ALPHABET.indexOf(encoded.charAt(index));
	const RESET = 32; // the top bit of a 6-bit character
	let value = valueAt(0);
	let position = RESET;
	let index = 1;

	// Read `count` bits, least significant first.
	const read = (count: number): number => {
		let bits = 0;

		for (let power = 1; power !== 1 << count; power <<= 1) {
			const bit = value & position;

			position >>= 1;

			if (position === 0) {
				position = RESET;
				value = valueAt(index);
				index += 1;
			}

			bits |= (bit > 0 ? 1 : 0) * power;
		}

		return bits;
	};

	// Codes 0–2 are reserved: an 8-bit literal, a 16-bit literal, end of stream.
	const dictionary: string[] = ["", "", ""];
	let enlargeIn = 4;
	let bitWidth = 3;

	const literal = (code: number): string | undefined => {
		if (code === 0) {
			return String.fromCharCode(read(8));
		}

		return code === 1 ? String.fromCharCode(read(16)) : undefined;
	};

	const first = literal(read(2));

	if (first === undefined) {
		return undefined;
	}

	dictionary.push(first);

	let previous = first;
	const out = [first];

	for (;;) {
		if (index > encoded.length) {
			return undefined; // ran off the end without an end-of-stream code
		}

		let code = read(bitWidth);

		if (code === 2) {
			return out.join("");
		}

		if (code < 2) {
			dictionary.push(literal(code));
			code = dictionary.length - 1;
			enlargeIn -= 1;

			if (enlargeIn === 0) {
				enlargeIn = 1 << bitWidth;
				bitWidth += 1;
			}
		}

		let entry: string;

		if (code < dictionary.length) {
			entry = dictionary[code];
		} else if (code === dictionary.length) {
			entry = previous + previous.charAt(0);
		} else {
			return undefined;
		}

		out.push(entry);
		dictionary.push(previous + entry.charAt(0));
		enlargeIn -= 1;
		previous = entry;

		if (enlargeIn === 0) {
			enlargeIn = 1 << bitWidth;
			bitWidth += 1;
		}
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
		const json = decompressFromEncodedURIComponent(fragment.slice("code/v2/".length));

		return json === undefined ? undefined : v2Project(json);
	}

	if (fragment.startsWith("code/")) {
		const source = decompressFromEncodedURIComponent(fragment.slice("code/".length));

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
