/**
 * test262 (tc39, BSD-3) as an oracle corpus — ASSIGNMENT §5 S0 item 3.
 *
 * Each test is a small self-checking program: it `throw`s a `Test262Error` on failure, so a positive
 * test passes when it completes without throwing (async tests instead call `$DONE`). Its YAML
 * frontmatter carries `flags` (`onlyStrict`/`noStrict`/`raw`/`module`/`async`), `features`,
 * `includes` (extra harness files) and `negative` (an expected error). That metadata is how the
 * supported-surface policy is applied as a *filter* rather than a per-test judgment: strict-only and
 * unflagged tests run; `noStrict` (sloppy-mode-only behavior) and `module` (exports aren't modeled)
 * are out of scope; parse-phase negative tests test the parser, not the interpreter.
 *
 * Two roots: `vendor/test262-sample/` is checked in (a deterministic 1-in-25 sample, always run by
 * `npm test`); `vendor/test262/` is the full pinned checkout (`npm run test262:fetch`, gitignored)
 * for `npm run test262:report`.
 */
import fs from "node:fs";
import path from "node:path";

export const TEST262_PIN = "419d3e0a";
export const FULL_ROOT = path.resolve(import.meta.dirname, "../../vendor/test262");
export const SAMPLE_ROOT = path.resolve(import.meta.dirname, "../../vendor/test262-sample");

export interface Test262Meta {
	"description"?: string;
	"flags": string[];
	"features": string[];
	"includes": string[];
	"negative"?: { "phase": string; "type": string };
}

export interface Test262Test {
	/** path relative to `test/language/`, e.g. `statements/class/…/x.js` — the stable id. */
	"id": string;
	"meta": Test262Meta;
	/** the test body (frontmatter included; it's a comment). */
	"source": string;
}

/** Minimal parser for test262's frontmatter YAML subset: scalars, `[a, b]` lists, `- a` lists, the `negative` map. */
export function parseFrontmatter(source: string): Test262Meta {
	const meta: Test262Meta = { "flags": [], "features": [], "includes": [] };
	const match = /\/\*---([\s\S]*?)---\*\//.exec(source);

	if (match === null) { return meta; }
	let currentList: string[] | undefined;
	let inNegative = false;
	const listOf = (key: string): string[] | undefined => (key === "flags" ? meta.flags : key === "features" ? meta.features : key === "includes" ? meta.includes : undefined);

	for (const raw of match[1].split("\n")) {
		const line = raw.replace(/\s+$/, "");

		if (line.trim() === "") { continue; }
		const indented = /^\s/.test(line);

		if (indented && inNegative) {
			const kv = /^\s*(\w+):\s*(.+)$/.exec(line);

			if (kv && meta.negative) { (meta.negative as unknown as Record<string, string>)[kv[1]] = kv[2].trim(); }
			continue;
		}

		if (indented && currentList !== undefined) {
			const item = /^\s*-\s*(.+)$/.exec(line);

			if (item) { currentList.push(item[1].trim()); }
			continue;
		}

		inNegative = false;
		currentList = undefined;
		const kv = /^(\w+):\s*(.*)$/.exec(line);

		if (kv === null) { continue; }
		const [, key, value] = kv;
		const list = listOf(key);

		if (list !== undefined) {
			const inline = /^\[(.*)\]$/.exec(value.trim());

			if (inline) { list.push(...inline[1].split(",").map((s) => s.trim()).filter(Boolean)); } else { currentList = list; }
		} else if (key === "negative") {
			meta.negative = { "phase": "", "type": "" };
			inNegative = true;
		} else if (key === "description") {
			meta.description = value.trim();
		}
	}

	return meta;
}

export function hasCorpus(root: string): boolean {
	return fs.existsSync(path.join(root, "test/language")) && fs.existsSync(path.join(root, "harness/assert.js"));
}

/** Every test under `<root>/test/language/` (fixtures excluded), in stable sorted order, lazily read. */
export function *loadTest262(root: string, filter?: (id: string) => boolean): Generator<Test262Test> {
	const language = path.join(root, "test/language");
	const walk = function *(dir: string): Generator<string> {
		for (const entry of fs.readdirSync(dir, { "withFileTypes": true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);

			if (entry.isDirectory()) { yield* walk(full); } else if (entry.name.endsWith(".js") && !entry.name.endsWith("_FIXTURE.js")) { yield full; }
		}
	};

	if (!hasCorpus(root)) { return; }
	for (const file of walk(language)) {
		const id = path.relative(language, file).split(path.sep).join("/");

		if (filter !== undefined && !filter(id)) { continue; }
		const source = fs.readFileSync(file, "utf8");

		yield { "id": id, "meta": parseFrontmatter(source), "source": source };
	}
}

const harnessCache = new Map<string, string>();

export function harnessFile(root: string, name: string): string {
	const key = `${root}\0${name}`;
	let text = harnessCache.get(key);

	if (text === undefined) {
		text = fs.readFileSync(path.join(root, "harness", name), "utf8");
		harnessCache.set(key, text);
	}

	return text;
}

/** Async tests report via `$DONE` → `print`. We make the printed line the program's completion value.
 *  test262 is a *script* suite: `asyncHelpers.js` checks `$DONE` is an own property of globalThis
 *  (a script's top-level function declarations are), so the epilogue installs it there explicitly —
 *  tsval's own top-level bindings are module-scoped by policy. */
const ASYNC_PRELUDE = `let __t262_done; const __t262_result = new Promise((r) => { __t262_done = r; }); function print(s) { __t262_done(String(s)); }\n`;
const ASYNC_BRIDGE = `\n;if (typeof $DONE === "function") globalThis.$DONE = $DONE;\n`;
const ASYNC_EPILOGUE = `\n;__t262_result;`;

/** Assemble the runnable program: harness + includes + test (and the async plumbing when flagged). */
export function assembleProgram(root: string, test: Test262Test): string {
	const isAsync = test.meta.flags.includes("async");
	const includes = ["assert.js", "sta.js", ...(isAsync ? ["doneprintHandle.js"] : []), ...test.meta.includes];
	const harness = [...new Set(includes)].map((name) => harnessFile(root, name)).join("\n");

	return `${isAsync ? ASYNC_PRELUDE : ""}${harness}${isAsync ? ASYNC_BRIDGE : ""}\n${test.source}${isAsync ? ASYNC_EPILOGUE : ""}`;
}
