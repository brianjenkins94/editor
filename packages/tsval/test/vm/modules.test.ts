import assert from "node:assert";
import { test } from "node:test";
import { runToEnd } from "../../src/explore.ts";
import { createVM } from "../../src/interpret.ts";
import type { ModuleLoader, ModuleRecord } from "../../src/modules.ts";

/** A loader over `files` (the program's, by absolute path) and `natives` (anything else, by specifier) — as almostnode's
 *  Runtime is one, in a form a test can see into. */
function loaderOf(files: Record<string, string>, natives: Record<string, unknown> = {}): ModuleLoader & { "loads": string[] } {
	const cache = new Map<string, ModuleRecord>();
	const loads: string[] = [];
	const normalize = (path: string): string => path.split("/").reduce<string[]>((parts, part) => (part === ".." ? parts.slice(0, -1) : part === "." || part === "" ? parts : [...parts, part]), []).join("/");

	return {
		"loads": loads,
		"resolve": (specifier, fromDir) => {
			if (Object.hasOwn(natives, specifier)) {
				return { "kind": "package", "filename": specifier };
			}

			const base = "/" + normalize(specifier.startsWith("/") ? specifier : `${fromDir}/${specifier}`);

			for (const extension of ["", ".js", ".ts"]) {
				if (Object.hasOwn(files, base + extension)) {
					return { "kind": "program", "filename": base + extension };
				}
			}

			throw new Error(`Cannot find module '${specifier}'`);
		},
		"require": (specifier) => natives[specifier],
		"source": (filename) => { loads.push(filename); return files[filename]!; },
		"cached": (filename) => cache.get(filename),
		"register": (filename, module) => { cache.set(filename, module); },
		"forget": (filename) => { cache.delete(filename); }
	};
}

/** Run `entry` of `files` to its end: what it logged. */
async function run(files: Record<string, string>, entry: string, natives: Record<string, unknown> = {}): Promise<unknown[]> {
	const lines: unknown[] = [];
	const { vm } = createVM(files[entry]!, { "fileName": entry, "modules": loaderOf(files, natives), "globals": { "log": (value: unknown) => { lines.push(value); } }, "eventLoop": { "pace": "fast" } });

	await runToEnd(vm);

	return lines;
}

test("CommonJS: a program file required is tsval's — its exports the call's value; a package is the host's", async () => {
	const files = {
		"/w/main.js": "const math = require('./math');\nconst pad = require('left-pad');\nlog(pad(String(math.add(2, 3)), 3));\n",
		"/w/math.js": "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n"
	};

	assert.deepStrictEqual(await run(files, "/w/main.js", { "left-pad": (text: string, width: number) => text.padStart(width, "0") }), ["005"]);
});

test("stepping goes into a required file: a breakpoint in it stops there, with its own file and scope", async () => {
	const files = {
		"/w/main.js": "const math = require('./math.js');\nlog(math.add(2, 3));\n",
		"/w/math.js": "const offset = 10;\nfunction add(a, b) {\n  return a + b + offset;\n}\nmodule.exports = { add };\n"
	};
	const lines: unknown[] = [];
	const { vm } = createVM(files["/w/main.js"], { "fileName": "/w/main.js", "modules": loaderOf(files), "globals": { "log": (value: unknown) => { lines.push(value); } }, "eventLoop": { "pace": "fast" } });

	vm.addBreakpointsInFile("/w/math.js", 5);
	vm.runToBreakpoint();
	assert.deepStrictEqual({ "file": vm.location()?.file, "line": vm.location()?.line }, { "file": "/w/math.js", "line": 4 }, "the module's last statement, as it loads");
	assert.strictEqual(vm.top?.scope.get("offset"), 10);

	vm.breakpoints.clear();
	vm.addBreakpointsInFile("/w/math.js", 3);
	vm.runToBreakpoint();
	assert.deepStrictEqual([vm.location()?.file, vm.location()?.line], ["/w/math.js", 2], "inside add, called from main");
	await runToEnd(vm);
	assert.deepStrictEqual(lines, [15]);
});

test("ES modules: named, default, re-exported — the imported files evaluated first, in order, each once", async () => {
	const files = {
		"/w/main.ts": "import { greet, name } from './greet';\nimport answer from './answer';\nimport * as all from './all';\nlog('main');\nlog(greet(name));\nlog(answer);\nlog(all.greet === greet && all.answer);\n",
		"/w/greet.ts": "log('greet');\nexport const name: string = 'ada';\nexport function greet(who: string) { return 'hello, ' + who; }\n",
		"/w/answer.ts": "import { name } from './greet';\nlog('answer, after ' + name);\nexport default 42;\n",
		"/w/all.ts": "export * from './greet';\nexport { default as answer } from './answer';\n"
	};

	assert.deepStrictEqual(await run(files, "/w/main.ts"), ["greet", "answer, after ada", "main", "hello, ada", 42, 42]);
});

test("a cycle sees the partial exports, as Node's does", async () => {
	const files = {
		"/w/a.js": "exports.early = 'a-early';\nconst b = require('./b');\nexports.late = 'a-late';\nlog(b.seen);\n",
		"/w/b.js": "const a = require('./a');\nexports.seen = Object.keys(a).join(',');\n"
	};

	assert.deepStrictEqual(await run({ ...files, "/w/main.js": "require('./a');\n" }, "/w/main.js"), ["early"]);
});

test("a module that threw leaves the cache: required again, it's tried again", async () => {
	const files = {
		"/w/main.js": "let tries = 0;\nglobalThis.count = () => ++tries;\ntry { require('./flaky'); } catch (error) { log('threw: ' + error.message); }\nlog(require('./flaky').ok);\n",
		"/w/flaky.js": "if (count() === 1) throw new Error('first time');\nexports.ok = 'second time';\n"
	};

	assert.deepStrictEqual(await run(files, "/w/main.js"), ["threw: first time", "second time"]);
});

test("a fork mid-import runs on as the original does", async () => {
	const files = {
		"/w/main.js": "const list = require('./list');\nlog(list.total());\n",
		"/w/list.js": "const items = [1, 2, 3];\nexports.total = () => items.reduce((sum, item) => sum + item, 0);\n"
	};
	const out: unknown[][] = [[], []];
	const { vm } = createVM(files["/w/main.js"], { "fileName": "/w/main.js", "modules": loaderOf(files), "globals": { "log": (value: unknown) => { out[0]!.push(value); } }, "eventLoop": { "pace": "fast" } });

	vm.addBreakpointsInFile("/w/list.js", 2);
	vm.runToBreakpoint();

	const fork = vm.fork();

	vm.breakpoints.clear();
	fork.breakpoints.clear();
	await runToEnd(fork);
	await runToEnd(vm);
	assert.deepStrictEqual(out[0], [6, 6], "the fork, then the original — each its own run of the module");
});

test("a profile is per file: each module's top-level statements", async () => {
	const files = {
		"/w/main.js": "const work = require('./work');\nlog(work.sum(100));\n",
		"/w/work.js": "exports.sum = (n) => { let total = 0; for (let i = 0; i < n; i += 1) total += i; return total; };\n"
	};
	const { vm } = createVM(files["/w/main.js"], { "fileName": "/w/main.js", "modules": loaderOf(files), "profile": true, "globals": { "log": () => undefined }, "eventLoop": { "pace": "fast" } });

	await runToEnd(vm);

	const byFile = new Map<string, number>();

	for (const [statement, entry] of vm.profile!) {
		byFile.set(statement.getSourceFile().fileName, (byFile.get(statement.getSourceFile().fileName) ?? 0) + entry.steps);
	}

	assert.ok(byFile.get("/w/work.js")! > byFile.get("/w/main.js")!, "the loop's work is work.js's");
});

test("without a loader, imports are resolveModule's, as before", async () => {
	const lines: unknown[] = [];
	const { vm } = createVM("import { twice } from 'helpers';\nlog(twice(21));\n", { "resolveModule": () => ({ "twice": (n: number) => n * 2 }), "globals": { "log": (value: unknown) => { lines.push(value); } } });

	vm.run();
	assert.deepStrictEqual(lines, [42]);
});
