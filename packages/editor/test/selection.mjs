/**
 * CI's selection of the architecture suites (packages/silo/README.md, *Which tests reach what*: "Selecting", "Trust"):
 * which shards a change reached, by what each test reached when it last ran — its reach, read under COVERAGE=1
 * (architecture-harness.mjs) and kept, by declaration, in `.silo/evidence/ci/architecture.json`, which CI commits when it
 * changes. Selection is the editor's and CI's, not the silo command line's.
 *
 *   node test/selection.mjs select <base>   — the shards to run for the change from <base> to HEAD, as the workflow's
 *                                             matrix (`{"include":[…]}` on stdout), selected by the records at <base>
 *   node test/selection.mjs merge <dir>     — fold the reach a run wrote (<dir>/<suite file>.json) into the records
 *
 * A declaration is a file's top-level one, by name, or a class's member (`Class.member`); a file's other top-level
 * statements are its `(top level)`. A change's declarations are those whose tokens differ from the base's, so a
 * reformat or a comment selects nothing. They select the tests that reached them — but code a suite's every session
 * reaches (at boot, or by at least AMBIENT of its tests) selects only the smoke suite, as any session would run it. A
 * change outside the code the records know (a dependency, a build script, the workflow) selects every shard; one the
 * suites don't run (a doc, a unit test, `.silo/`), none; a suite file, its own shard; ARCHITECTURE.md's diagram, the
 * tours. Any change to code runs the smoke and performance shards. A test with no record yet runs, by its shard.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";

/** The repository's root, and the records' place in it. */
const ROOT = path.resolve(url.fileURLToPath(new URL("../../../", import.meta.url)));
export const RECORDS = ".silo/evidence/ci/architecture.json";

/** The workflow's shards: each a name and the suite files it runs (architecture.yml's matrix comes from here). */
export const SHARDS = [
	{ "shard": "smoke-app", "files": ["test/worker-realms.mjs", "test/architecture-smoke.mjs", "test/architecture-app.mjs", "test/contrib.mjs", "test/pane-views.mjs"] },
	{ "shard": "tour-previews", "files": ["test/architecture-tour-previews.mjs"] },
	{ "shard": "tour-runs", "files": ["test/architecture-tour-runs.mjs"] },
	{ "shard": "tour-capabilities", "files": ["test/architecture-tour-capabilities.mjs"] },
	// (alone, so nothing else shares the CPU while it measures; never instrumented)
	{ "shard": "performance", "files": ["test/performance.mjs"] }
];

/** A share of a suite's tests reaching a declaration past which it's ambient: any session runs it (decided 2026-10-24). */
export const AMBIENT = 0.3;
/** The test whose reach is boot's: code it reaches runs in every session. */
const BOOT = "boot: every realm reports";

/** The shard a suite file (`test/<name>.mjs`, from packages/editor) is in. */
export function shardOf(file) {
	return SHARDS.find((each) => each.files.includes(file))?.shard;
}

/** `text`'s declarations (a TypeScript or JavaScript file's): each a name and the ranges it covers — a top-level
 *  declaration's, a class member's (`Class.member`, the class's own name keeping what's left of it), the rest of the
 *  file's top level as `(top level)`. */
export function declarationsOf(fileName, text) {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.[cm]?[jt]sx$/u.test(fileName) ? ts.ScriptKind.TSX : undefined);
	const declarations = new Map();
	const add = (name, node) => {
		const ranges = declarations.get(name) ?? [];

		ranges.push([node.getStart(source), node.getEnd()]);
		declarations.set(name, ranges);
	};

	for (const statement of source.statements) {
		const named = nameOf(statement);

		if (named === undefined) {
			add("(top level)", statement);
		} else if (ts.isClassDeclaration(statement)) {
			add(named, statement);

			for (const member of statement.members) {
				add(`${named}.${memberName(member, source)}`, member);
			}
		} else {
			add(named, statement);
		}
	}

	return declarations;
}

/** A top-level statement's name, when it declares one. */
function nameOf(statement) {
	if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
		return statement.name?.getText() ?? "default";
	}

	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.map((each) => each.name.getText()).join(", ");
	}

	return ts.isExportAssignment(statement) ? "default" : undefined;
}

function memberName(member, source) {
	if (ts.isConstructorDeclaration(member)) {
		return "constructor";
	}

	return member.name === undefined ? `(${source.getLineAndCharacterOfPosition(member.getStart(source)).line})` : member.name.getText(source);
}

/** The declaration holding `offset`: the innermost — a member's, over its class's. */
function holding(declarations, offset) {
	let found;
	let width = Number.POSITIVE_INFINITY;

	for (const [name, ranges] of declarations) {
		for (const [start, end] of ranges) {
			if (start <= offset && offset < end && end - start < width) {
				found = name;
				width = end - start;
			}
		}
	}

	return found;
}

/** The declarations of `text` that `statements` ([startLine, startCharacter, …], 0-based, as instrument.ts counts them)
 *  are in. */
export function declarationsReached(fileName, text, statements) {
	const declarations = declarationsOf(fileName, text);
	const starts = [0];

	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		starts.push(index + 1);
	}

	const names = new Set();

	for (const [line, character] of statements) {
		const name = holding(declarations, (starts[line] ?? text.length) + character);

		if (name !== undefined) {
			names.add(name);
		}
	}

	return [...names].toSorted();
}

/** A declaration's tokens, without whitespace or comments: what a reformat doesn't change. */
function tokensOf(text, ranges) {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
	const tokens = [];

	for (const [start, end] of ranges) {
		scanner.setText(text, start, end - start);

		for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
			tokens.push(scanner.getTokenText());
		}
	}

	return tokens.join(" ");
}

/** The declarations a change to `fileName` made — added, removed, or with other tokens — from `before` (undefined: the
 *  file is new) to `after` (undefined: it's gone). */
export function changedDeclarations(fileName, before, after) {
	const was = before === undefined ? new Map() : declarationsOf(fileName, before);
	const now = after === undefined ? new Map() : declarationsOf(fileName, after);

	return [...new Set([...was.keys(), ...now.keys()])].filter((name) => !was.has(name) || !now.has(name) || tokensOf(before, was.get(name)) !== tokensOf(after, now.get(name))).toSorted();
}

/** Which test files the records' tests are in, by shard; and per declaration (`file › name`), the tests that reached it. */
function indexOf(records) {
	const reached = new Map();

	for (const [file, names] of Object.entries(records.reach ?? {})) {
		for (const [name, tests] of Object.entries(names)) {
			reached.set(`${file} › ${name}`, tests.map((index) => records.tests[index]));
		}
	}

	return reached;
}

/** Whether the tests reaching a declaration make it ambient: boot's among them, or AMBIENT of a shard's tests. */
function ambient(tests, records) {
	if (tests.some((test) => test.name === BOOT)) {
		return true;
	}

	return SHARDS.some(({ shard }) => {
		const all = records.tests.filter((test) => test.shard === shard).length;

		return all > 0 && tests.filter((test) => test.shard === shard).length / all >= AMBIENT;
	});
}

/** ARCHITECTURE.md: its diagram is the tours' (the `diagram` job checks it against what they saw). */
const ARCHITECTURE = "packages/editor/ARCHITECTURE.md";

/** What a changed file is: nothing the suites run (a doc, a unit test, `.silo/`, the theme's budget), a suite file (its
 *  shard), ARCHITECTURE.md (its diagram: the tours'), code the records may know (its declarations), or anything else
 *  (every shard). */
export function kindOf(file) {
	if (file === ARCHITECTURE) {
		return { "kind": "diagram" };
	}

	const suite = file.startsWith("packages/editor/") ? shardOf(file.slice("packages/editor/".length)) : undefined;

	if (suite !== undefined) {
		return { "kind": "suite", "shard": suite };
	}

	// (the architecture suites' harness, session and this selection are the suites' own: every shard)
	const unit = (/^packages\/[^/]+\/test\//u.test(file) && !file.startsWith("packages/editor/test/")) || /\.test\.[cm]?[jt]sx?$/u.test(file);

	if (file.endsWith(".md") || unit || file.startsWith(".silo/") || file === "packages/theme/budget.json") {
		return { "kind": "none" };
	}

	const code = /\.(?:[cm]?[jt]sx?)$/u.test(file) && /^(?:packages\/[^/]+\/(?!test\/)|components\/)/u.test(file);

	return code ? { "kind": "code" } : { "kind": "other" };
}

/** Whether a change to ARCHITECTURE.md changed its diagram (the block the tours write), not only its prose. */
export function diagramChanged(before, after) {
	const block = (text) => {
		const begin = text?.indexOf("<!-- architecture-tour:begin -->") ?? -1;

		return begin === -1 ? "" : text.slice(begin, text.indexOf("<!-- architecture-tour:end -->", begin));
	};

	return block(before) !== block(after);
}

/**
 * The shards to run, and why: `changes` each `{ file, declarations }` (declarations: those it changed, for code), the
 * records at the base, and the tests each shard has now (`tests`: `{ shard, name }`) — a test the records don't have runs.
 */
export function select(changes, records, tests) {
	const reached = indexOf(records);
	const shards = new Map();
	const because = (shard, why) => {
		if (!shards.has(shard)) {
			shards.set(shard, why);
		}
	};

	for (const change of changes) {
		const what = kindOf(change.file);

		if (what.kind === "none") {
			continue;
		}

		// (`declarations` says whether its diagram changed: then the tours, which see what it draws)
		if (what.kind === "diagram") {
			for (const { shard } of SHARDS.filter((each) => each.shard.startsWith("tour-") && change.declarations.length > 0)) {
				because(shard, "ARCHITECTURE.md's diagram changed");
			}

			continue;
		}

		if (what.kind === "suite") {
			because(what.shard, `${change.file} changed`);

			continue;
		}

		if (what.kind === "other") {
			for (const { shard } of SHARDS) {
				because(shard, `${change.file} isn't code a test's reach says anything of`);
			}

			continue;
		}

		because("smoke-app", "code changed");
		because("performance", "code changed");

		for (const name of change.declarations) {
			const by = reached.get(`${change.file} › ${name}`) ?? [];

			if (ambient(by, records)) {
				because("smoke-app", `${change.file} › ${name} is ambient`);

				continue;
			}

			for (const test of by) {
				because(test.shard, `${change.file} › ${name} was reached by "${test.name}"`);
			}
		}
	}

	// (once anything's run: a test no record has yet runs, by its shard — but performance's, which are never instrumented)
	if (shards.size > 0) {
		const known = new Set(records.tests.map((test) => `${test.shard} › ${test.name}`));

		for (const test of tests.filter((each) => each.shard !== "performance")) {
			if (!known.has(`${test.shard} › ${test.name}`)) {
				because(test.shard, `"${test.name}" has no record yet`);
			}
		}
	}

	return SHARDS.filter(({ shard }) => shards.has(shard)).map((each) => ({ ...each, "why": shards.get(each.shard) }));
}

/** The records with a run's reach folded in (`reach`: by suite file name, `{ [test]: { [file]: statements } }`): each
 *  test that ran keeps what it reached before and adds what it reached now (sets grow: a declaration no longer in its
 *  file drops out, so a flicker of async work doesn't churn them); `textOf` reads a file as it is. */
export function merged(records, reach, textOf) {
	const tests = [...records.tests ?? []];
	const sets = new Map(tests.map((test, index) => [index, new Set()]));

	for (const [file, names] of Object.entries(records.reach ?? {})) {
		for (const [name, indexes] of Object.entries(names)) {
			for (const index of indexes) {
				sets.get(index)?.add(`${file} › ${name}`);
			}
		}
	}

	for (const [suite, ran] of Object.entries(reach)) {
		const shard = shardOf(`test/${suite}.mjs`);

		if (shard === undefined) {
			continue;
		}

		for (const [name, files] of Object.entries(ran)) {
			let index = tests.findIndex((test) => test.shard === shard && test.name === name);

			if (index === -1) {
				index = tests.push({ "shard": shard, "name": name }) - 1;
				sets.set(index, new Set());
			}

			for (const [file, statements] of Object.entries(files)) {
				const text = textOf(file);

				if (text !== undefined) {
					for (const declaration of declarationsReached(file, text, statements)) {
						sets.get(index).add(`${file} › ${declaration}`);
					}
				}
			}
		}
	}

	// (a declaration kept only while its file still has it)
	const known = new Map();
	const exists = (key) => {
		const [file, name] = key.split(" › ");

		if (!known.has(file)) {
			const text = textOf(file);

			known.set(file, text === undefined ? new Set() : new Set(declarationsOf(file, text).keys()));
		}

		return known.get(file).has(name);
	};
	// (Maps: a declaration can be named as an object's own property is — `constructor`)
	const byDeclaration = new Map();

	for (const [index, keys] of sets) {
		for (const key of keys) {
			if (exists(key)) {
				const [file, name] = key.split(" › ");
				const names = byDeclaration.get(file) ?? new Map();

				names.set(name, [...names.get(name) ?? [], index]);
				byDeclaration.set(file, names);
			}
		}
	}

	const sorted = Object.fromEntries([...byDeclaration.keys()].toSorted().map((file) => [file, Object.fromEntries([...byDeclaration.get(file).keys()].toSorted().map((name) => [name, byDeclaration.get(file).get(name).toSorted((left, right) => left - right)]))]));

	return { "version": 1, "tests": tests, "reach": sorted };
}

/** The tests each shard has now, by their `test("…")` titles. */
function testsNow() {
	return SHARDS.flatMap(({ shard, files }) => files.flatMap((file) => {
		const text = fs.readFileSync(path.join(ROOT, "packages/editor", file), "utf8");

		return [...text.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gmu)].map(([, name]) => ({ "shard": shard, "name": JSON.parse(`"${name}"`) }));
	}));
}

const git = (...args) => execFileSync("git", args, { "cwd": ROOT, "encoding": "utf8", "maxBuffer": 256 * 1024 * 1024 });
const shown = (ref, file) => {
	try {
		return git("show", `${ref}:${file}`);
	} catch {
		return undefined;
	}
};

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
	const [command, argument] = process.argv.slice(2);

	if (command === "select") {
		// (the records at the base: a change can't skip its own tests by editing them — "Trust")
		// (none, or all zeros: a run by hand, or a branch's first push — everything runs)
		const base = argument === undefined || argument === "" || /^0+$/u.test(argument) ? undefined : argument;
		const records = base === undefined ? null : JSON.parse(shown(base, RECORDS) ?? "null");
		const files = base === undefined || records === null ? undefined : git("diff", "--name-only", base, "HEAD").split("\n").filter((line) => line !== "");
		const now = (file) => (fs.existsSync(path.join(ROOT, file)) ? fs.readFileSync(path.join(ROOT, file), "utf8") : undefined);
		const declarations = (file) => {
			const { kind } = kindOf(file);

			if (kind === "diagram") {
				return diagramChanged(shown(base, file), now(file)) ? ["(diagram)"] : [];
			}

			return kind === "code" ? changedDeclarations(file, shown(base, file), now(file)) : [];
		};
		const chosen = files === undefined ? SHARDS.map((each) => ({ ...each, "why": base === undefined ? "no base" : "no records at the base" })) : select(files.map((file) => ({ "file": file, "declarations": declarations(file) })), records, testsNow());

		for (const { shard, why } of chosen) {
			console.error(`${shard}: ${why}`);
		}

		console.log(JSON.stringify({ "include": chosen.map(({ shard, files: suites }) => ({ "shard": shard, "files": suites.join(" ") })) }));
	} else if (command === "merge") {
		const reach = Object.fromEntries(fs.readdirSync(argument).filter((name) => name.endsWith(".json")).map((name) => [name.slice(0, -".json".length), JSON.parse(fs.readFileSync(path.join(argument, name), "utf8"))]));
		const file = path.join(ROOT, RECORDS);
		const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { "version": 1, "tests": [], "reach": {} };
		const textOf = (name) => (fs.existsSync(path.join(ROOT, name)) ? fs.readFileSync(path.join(ROOT, name), "utf8") : undefined);

		fs.mkdirSync(path.dirname(file), { "recursive": true });
		fs.writeFileSync(file, JSON.stringify(merged(records, reach, textOf), null, "\t") + "\n");
	} else {
		console.error("usage: node test/selection.mjs select <base> | merge <reach dir>");
		process.exitCode = 2;
	}
}
