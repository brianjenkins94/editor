/**
 * The module system a host shares (packages/tsval/README.md, *Modules*): almostnode resolves — built-ins, packages, the program's own files — and
 * a host may evaluate the program's files its own way (`evaluateProgram`), give the program's code built-ins of its own
 * (`builtinFor`), and put a module it evaluated in the cache (`register`).
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

// (almostnode's sources import each other without extensions: see extensionless.mjs.)
import "./extensionless.mjs";

const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");

type Files = Record<string, string>;
type Evaluate = NonNullable<ConstructorParameters<typeof Runtime>[1]>["evaluateProgram"];

/** A host's evaluator, as plain JavaScript run with the module's require (a debugger would step it instead). */
const evaluate: Evaluate = (module, require, source) => {
	// eslint-disable-next-line ts/no-implied-eval, no-new-func -- standing in for a host's evaluator is this test's point
	new Function("module", "exports", "require", source)(module, module.exports, require);
};

/** A VFS with `files` (paths under /workspace), and a runtime on it. */
function runtimeWith(files: Files, options: ConstructorParameters<typeof Runtime>[1] = {}): InstanceType<typeof Runtime> {
	const vfs = new VirtualFS();

	for (const [path, text] of Object.entries(files)) {
		vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { "recursive": true });
		vfs.writeFileSync(path, text);
	}

	return new Runtime(vfs, { "cwd": "/workspace", ...options });
}

const PACKAGE = {
	"/workspace/node_modules/greet/package.json": JSON.stringify({ "name": "greet", "main": "index.js" }),
	"/workspace/node_modules/greet/index.js": "const fs = require('fs'); module.exports = { 'hello': (who) => 'hello, ' + who, 'fs': fs };"
};

test("resolve: a built-in by its name, a package's file, a program file — TypeScript too", () => {
	const runtime = runtimeWith({ ...PACKAGE, "/workspace/util.ts": "export const one = 1;", "/workspace/lib/index.ts": "export {};" });

	assert.deepEqual(runtime.resolve("node:path"), { "kind": "builtin", "filename": "path" });
	assert.deepEqual(runtime.resolve("greet"), { "kind": "package", "filename": "/workspace/node_modules/greet/index.js" });
	assert.deepEqual(runtime.resolve("./util"), { "kind": "program", "filename": "/workspace/util.ts" });
	assert.deepEqual(runtime.resolve("./lib"), { "kind": "program", "filename": "/workspace/lib/index.ts" });
	assert.throws(() => runtime.resolve("./missing"), /Cannot find module/u);
});

test("evaluateProgram: the program's files are the host's to evaluate, from their source — packages are almostnode's", () => {
	const evaluated: string[] = [];
	const runtime = runtimeWith({
		...PACKAGE,
		"/workspace/main.js": "const greet = require('greet'); const name = require('./name.js'); module.exports = greet.hello(name);",
		"/workspace/name.js": "module.exports = 'ada';"
	}, {
		"evaluateProgram": (module, require, source) => {
			evaluated.push(module.filename);
			evaluate!(module, require, source);
		}
	});

	assert.equal(runtime.require("./main.js"), "hello, ada");
	assert.deepEqual(evaluated, ["/workspace/main.js", "/workspace/name.js"], "the program's two, not the package");
});

test("builtinFor: the program's code gets the host's built-ins; a package gets almostnode's", () => {
	const standIn = { "readFileSync": () => "a stand-in" };
	const runtime = runtimeWith({ ...PACKAGE, "/workspace/main.js": "module.exports = require('node:fs');" }, {
		"builtinFor": (id, requester) => (id === "fs" && requester === "program" ? standIn : undefined)
	});

	assert.equal(runtime.require("./main.js"), standIn);
	assert.equal(runtime.require("fs"), standIn, "the host asks on the program's behalf");
	assert.notEqual((runtime.require("greet") as { "fs": unknown }).fs, standIn, "the package's fs is almostnode's");
	assert.equal(typeof ((runtime.require("greet") as { "fs": { "readFileSync": unknown } }).fs.readFileSync), "function");
});

test("onPackage: each package whose code runs is told once, with its version — a nested install as its own", () => {
	const told: unknown[] = [];
	const runtime = runtimeWith({
		...PACKAGE,
		"/workspace/node_modules/greet/package.json": JSON.stringify({ "name": "greet", "version": "1.2.3", "main": "index.js" }),
		"/workspace/node_modules/greet/extra.js": "module.exports = require('@scope/inner');",
		"/workspace/node_modules/greet/node_modules/@scope/inner/package.json": JSON.stringify({ "name": "@scope/inner", "version": "0.1.0", "main": "index.js" }),
		"/workspace/node_modules/greet/node_modules/@scope/inner/index.js": "module.exports = 'inner';",
		"/workspace/main.js": "require('greet'); module.exports = require('greet/extra.js');"
	}, { "onPackage": (pkg) => { told.push(pkg); } });

	assert.equal(runtime.require("./main.js"), "inner");
	assert.deepEqual(told, [
		{ "name": "greet", "version": "1.2.3", "dir": "/workspace/node_modules/greet" },
		{ "name": "@scope/inner", "version": "0.1.0", "dir": "/workspace/node_modules/greet/node_modules/@scope/inner" }
	], "greet once though two of its files ran; the program's own file isn't a package");

	told.length = 0;
	runtime.clearCache();
	runtime.require("greet");
	assert.deepEqual(told, [{ "name": "greet", "version": "1.2.3", "dir": "/workspace/node_modules/greet" }], "after clearCache, told again");
});

test("builtinFor: told which module's folder asks — a package's, under its node_modules", () => {
	const asked: string[] = [];
	const runtime = runtimeWith({ ...PACKAGE, "/workspace/main.js": "require('greet'); module.exports = require('fs');" }, {
		"builtinFor": (id, requester, from) => {
			if (id === "fs") {
				asked.push(requester + " " + from);
			}

			return undefined;
		}
	});

	runtime.require("./main.js");
	assert.deepEqual(asked, ["package /workspace/node_modules/greet", "program /workspace"]);
});

test("globalFor: a package's own fetch, by its folder; the program and an unanswered module see the real one", () => {
	const asked: string[] = [];
	const counted = (): string => "counted";
	const runtime = runtimeWith({
		...PACKAGE,
		"/workspace/node_modules/caller/package.json": JSON.stringify({ "name": "caller", "main": "index.js" }),
		"/workspace/node_modules/caller/index.js": "module.exports = typeof fetch === 'function' ? fetch() : 'none';",
		"/workspace/main.js": "module.exports = { 'theirs': require('caller'), 'mine': fetch === globalThis.fetch };"
	}, {
		"globalFor": (name, requester, from) => {
			asked.push(`${name} ${requester} ${from}`);

			return requester === "package" ? counted : undefined;
		}
	});
	const exported = runtime.require("./main.js") as { "theirs": string; "mine": boolean };

	assert.equal(exported.theirs, "counted", "the package called the host's");
	assert.equal(exported.mine, true, "the program's is the real global");
	assert.ok(asked.includes("fetch package /workspace/node_modules/caller"));
	assert.ok(asked.includes("fetch program /workspace"));
});

test("register: a module the host evaluated is everyone's — a package requiring the program file gets the same one", () => {
	const runtime = runtimeWith({
		"/workspace/config.js": "module.exports = { 'evaluated': 'natively' };",
		"/workspace/node_modules/reader/package.json": JSON.stringify({ "name": "reader", "main": "index.js" }),
		"/workspace/node_modules/reader/index.js": "module.exports = () => require('../../config.js');"
	});
	const config = { "id": "/workspace/config.js", "filename": "/workspace/config.js", "exports": { "evaluated": "by the host" }, "loaded": true, "children": [], "paths": [] };

	runtime.register("/workspace/config.js", config);
	assert.equal((runtime.require("reader") as () => unknown)(), config.exports);
	assert.equal(runtime.cached("/workspace/config.js"), config);
});

test("a cycle between program files sees the partial exports, as Node's does", () => {
	const runtime = runtimeWith({
		"/workspace/a.js": "exports.early = 'a-early'; const b = require('./b.js'); exports.late = 'a-late'; exports.fromB = b.seen;",
		"/workspace/b.js": "const a = require('./a.js'); exports.seen = Object.keys(a).join(',');"
	}, {
		"evaluateProgram": evaluate
	});

	assert.deepEqual(runtime.require("./a.js"), { "early": "a-early", "late": "a-late", "fromB": "early" });
});

test("top-level await: an ES module's body awaits as Node's does — import() waits for it, require() can't", async () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/later/package.json": JSON.stringify({ "name": "later", "type": "module", "main": "index.js" }),
		"/workspace/node_modules/later/index.js": "import { one } from './one.js';\nexport const two = await Promise.resolve(one + 1);\nfor await (const each of [Promise.resolve(3)]) { globalThis.lastSeen = each; }\nexport const three = globalThis.lastSeen;\n",
		"/workspace/node_modules/later/default.js": "export default await Promise.resolve('ready');\n",
		"/workspace/node_modules/later/one.js": "export const one = 1;\n"
	});
	const imported = runtime.execute("module.exports = import('later');", "/workspace/main.js").exports as Promise<{ "two": number; "three": number }>;

	const later = await imported;

	assert.equal(later.two, 2, "what it exported once its await was done");
	assert.equal(later.three, 3, "and after a for await");
	assert.equal((await (runtime.execute("module.exports = import('later/default.js');", "/workspace/main.js").exports as Promise<{ "default": string }>)).default, "ready", "a default export, assigned once its await is done");
	assert.throws(() => runtimeWith({
		"/workspace/node_modules/later/package.json": JSON.stringify({ "name": "later", "main": "index.js" }),
		"/workspace/node_modules/later/index.js": "export default await new Promise(() => {});\n"
	}).execute("require('later');", "/workspace/main.js"), (error: { "code"?: string }) => error.code === "ERR_REQUIRE_ASYNC_MODULE");
	assert.equal(runtimeWith({ "/workspace/node_modules/sync/package.json": JSON.stringify({ "name": "sync", "main": "index.js" }), "/workspace/node_modules/sync/index.js": "async function later() { await 1; }\nexport const named = later;\n" }).execute("module.exports = typeof require('sync').named;", "/workspace/main.js").exports, "function", "an await inside a function isn't the top level's");
});

test("top-level await, imported: a module importing one waits for it, as Node's does — and so does whoever imports that", async () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/preset/package.json": JSON.stringify({ "name": "preset", "main": "index.js" }),
		"/workspace/node_modules/preset/index.js": "export default await Promise.resolve(['a', 'b']);\n",
		"/workspace/config.js": "import preset from 'preset';\nexport default [...preset, 'c'];\n",
		"/workspace/outer.js": "import config from './config.js';\nexport const count = config.length;\n"
	});
	const config = await (runtime.execute("module.exports = import('./config.js');", "/workspace/main.js").exports as Promise<{ "default": string[] }>);

	assert.deepEqual(config.default, ["a", "b", "c"], "its body ran once the preset's await was done");
	assert.equal((await (runtime.execute("module.exports = import('./outer.js');", "/workspace/main.js").exports as Promise<{ "count": number }>)).count, 3, "and a module importing it waited too");
});

test("nativeFileImports: false — import() of a file: URL is loaded from the runtime's files, its query dropped, as Node reads one", async () => {
	const runtime = runtimeWith({ "/workspace/eslint.config.js": "export default { 'rules': {} };\n" }, { "nativeFileImports": false });
	const config = await (runtime.execute("module.exports = import('file:///workspace/eslint.config.js?mtime=1');", "/workspace/main.js").exports as Promise<{ "default": unknown }>);

	assert.deepEqual(config.default, { "rules": {} });
});

test("a module is loaded once however many are: none is let go and loaded again as a second copy", () => {
	const files: Files = {};

	for (let index = 0; index < 2100; index += 1) {
		files[`/workspace/many/${index}.js`] = `module.exports = { "index": ${index} };`;
	}

	const runtime = runtimeWith(files);
	const same = runtime.execute("const first = require('./many/0.js');\nfor (let index = 1; index < 2100; index += 1) { require('./many/' + index + '.js'); }\nmodule.exports = require('./many/0.js') === first;", "/workspace/main.js").exports;

	assert.equal(same, true);
});

test("process.features: TypeScript, as Node's transform mode — a .ts file is loaded as it is", () => {
	assert.equal(runtimeWith({}).execute("module.exports = process.features.typescript;", "/workspace/main.js").exports, "transform");
});

test("require() of a folder by its path reads its package.json's main first, as Node's does", () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/tool/package.json": JSON.stringify({ "name": "tool", "main": "lib/api.js" }),
		"/workspace/node_modules/tool/lib/api.js": "module.exports = 'api';"
	});

	assert.equal(runtime.execute("module.exports = require('/workspace/node_modules/tool/');", "/workspace/main.js").exports, "api");
	assert.equal(runtime.execute("module.exports = require('./node_modules/tool');", "/workspace/main.js").exports, "api");
});

test("an ES module's own require (createRequire) isn't what its imports go through", () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/rules/package.json": JSON.stringify({ "name": "rules", "type": "module", "main": "index.js" }),
		"/workspace/node_modules/rules/index.js": "import mod from 'node:module';\nconst require = mod.createRequire(import.meta.url);\nimport { two } from './two.js';\nexport const both = require('./one.cjs') + two;\n",
		"/workspace/node_modules/rules/one.cjs": "module.exports = 1;",
		"/workspace/node_modules/rules/two.js": "export const two = 2;\n"
	});

	assert.equal((runtime.execute("module.exports = require('rules');", "/workspace/main.js").exports as { "both": number }).both, 3);
});

test("an ES module's exported declarations keep their local names, and its exports are live", () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/configs/package.json": JSON.stringify({ "name": "configs", "type": "module", "main": "index.js" }),
		"/workspace/node_modules/configs/index.js": [
			"export const eslintrc = { 'rules': { 'a': 1 } };",
			"export const flat = { 'rules': eslintrc.rules };",
			"export function early() { return late(); }",
			"export class Box { static of() { return new Box(); } }",
			"export const { left, 'right': [right] } = { 'left': 'L', 'right': ['R'] };",
			"export let count = 0;",
			"export function bump() { count += 1; }",
			"function late() { return 'late'; }",
			"const hidden = 'h';",
			"export { hidden as shown };"
		].join("\n")
	});
	const configs = runtime.execute("module.exports = require('configs');", "/workspace/main.js").exports as Record<string, unknown> & { "bump": () => void; "early": () => string; "Box": { "of": () => unknown } };

	assert.deepEqual(configs["flat"], { "rules": { "a": 1 } }, "a later declaration reads an earlier export by its name");
	assert.equal(configs.early(), "late");
	assert.ok(configs.Box.of() instanceof (configs.Box as unknown as new () => unknown));
	assert.deepEqual([configs["left"], configs["right"], configs["shown"]], ["L", "R", "h"]);
	configs.bump();
	assert.equal(configs["count"], 1, "live: the module's assignment is seen");
});

test("a built-in's subpaths, as Node has them: assert/strict, util/types, path/posix, stream/promises", () => {
	const runtime = runtimeWith({});
	const found = runtime.execute("module.exports = ['assert/strict', 'node:util/types', 'path/posix', 'stream/promises'].map((id) => typeof require(id));", "/workspace/main.js").exports;

	assert.deepEqual(found, ["function", "object", "object", "object"]);
});

test("string_decoder holds a character split across chunks, as Node's does", () => {
	const runtime = runtimeWith({});
	const text = runtime.execute(`
const { StringDecoder } = require("string_decoder");
const decoder = new StringDecoder("utf8");
const bytes = Buffer.from("h\u00e9\u20ac");
module.exports = decoder.write(bytes.subarray(0, 2)) + decoder.write(bytes.subarray(2, 4)) + decoder.end(bytes.subarray(4));
`, "/workspace/main.js").exports;

	assert.equal(text, "h\u00e9\u20ac");
});

test("streams are Node's: backpressure past the high-water mark, on almostnode's one EventEmitter and Buffer", async () => {
	const runtime = runtimeWith({});
	const found = runtime.execute(`
const { Writable, Readable, pipeline } = require("stream");
const writable = new Writable({ "highWaterMark": 4, "write": (chunk, encoding, callback) => { setTimeout(callback, 0); } });
const read = [];
module.exports = {
	"full": writable.write("12345"),
	"emitter": writable instanceof require("events"),
	"buffer": new Promise((resolve) => { Readable.from(["a", "b"], { "objectMode": false }).on("data", (chunk) => { read.push(Buffer.isBuffer(chunk)); }).on("end", () => { resolve(read); }); }),
	"piped": require("stream/promises").pipeline(Readable.from(["x"]), new Writable({ "objectMode": true, "write": (chunk, encoding, callback) => { callback(); } })).then(() => true)
};
`, "/workspace/main.js").exports as { "full": boolean; "emitter": boolean; "buffer": Promise<boolean[]>; "piped": Promise<boolean> };

	assert.equal(found.full, false, "a write past the high-water mark says to wait for drain");
	assert.equal(found.emitter, true);
	assert.deepEqual(await found.buffer, [true, true]);
	assert.equal(await found.piped, true);
});

test("EventEmitter is Node's: code written for Node inherits from it by EventEmitter.call(this)", () => {
	const runtime = runtimeWith({});
	const heard = runtime.execute(`
const EventEmitter = require("events");
function Tool() { EventEmitter.call(this); }
require("util").inherits(Tool, EventEmitter);
const tool = new Tool();
let heard = 0;
tool.on("ping", () => { heard += 1; });
tool.emit("ping");
module.exports = heard;
`, "/workspace/main.js").exports;

	assert.equal(heard, 1);
});

test("require('.') and require('..') are the folder and its parent, as Node reads them", () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/tool/package.json": JSON.stringify({ "name": "tool", "main": "lib/index.js" }),
		"/workspace/node_modules/tool/lib/index.js": "exports.name = 'lib';",
		"/workspace/node_modules/tool/lib/util/index.js": "exports.parent = require('..').name; exports.self = require('.').own;\nexports.own = 'util';"
	});

	assert.equal((runtime.execute("module.exports = require('tool/lib/util');", "/workspace/main.js").exports as { "parent": string }).parent, "lib");
});

test("a package whose entry is its index.json, as Node finds it", () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/ids/package.json": JSON.stringify({ "name": "ids", "version": "1.0.0" }),
		"/workspace/node_modules/ids/index.json": "[\"MIT\"]"
	});

	assert.deepEqual(runtime.execute("module.exports = require('ids');", "/workspace/main.js").exports, ["MIT"]);
});

test("process.getBuiltinModule: a built-in by its name, as require() gives it", () => {
	const runtime = runtimeWith({});

	assert.equal(runtime.execute("module.exports = process.getBuiltinModule('node:path') === require('path') && process.getBuiltinModule('fs') === require('fs') && process.getBuiltinModule('nope') === undefined;", "/workspace/main.js").exports, true);
});

test("import.meta.resolve: a specifier as the URL it resolves to", () => {
	const runtime = runtimeWith({
		...PACKAGE,
		"/workspace/node_modules/where/package.json": JSON.stringify({ "name": "where", "type": "module", "main": "index.js" }),
		"/workspace/node_modules/where/index.js": "export const greet = import.meta.resolve('greet');\nexport const path = import.meta.resolve('node:path');\n"
	});

	assert.deepEqual({ ...runtime.execute("module.exports = require('where');", "/workspace/main.js").exports as object }, { "greet": "file:///workspace/node_modules/greet/index.js", "path": "node:path" });
});

test("util.isDeepStrictEqual, as Node's", () => {
	assert.deepEqual(runtimeWith({}).execute("const { isDeepStrictEqual } = require('node:util'); module.exports = [isDeepStrictEqual({ 'a': [1] }, { 'a': [1] }), isDeepStrictEqual({ 'a': 1 }, { 'a': '1' })];", "/workspace/main.js").exports, [true, false]);
});

test("assert's legacy equal, and assert/strict's equal as strictEqual — as Node has them", () => {
	const found = runtimeWith({}).execute([
		"const legacy = require('assert'); const strict = require('node:assert/strict');",
		"const throws = (run) => { try { run(); return false; } catch { return true; } };",
		"module.exports = [throws(() => legacy.equal(1, '1')), throws(() => strict.equal(1, '1')), strict.strict === strict, typeof strict.deepEqual];"
	].join("\n"), "/workspace/main.js").exports;

	assert.deepEqual(found, [false, true, true, "function"]);
});

test("a package with main and module is required as its main, as Node does; module stands in only with no main", () => {
	const runtime = runtimeWith({
		"/workspace/node_modules/both/package.json": JSON.stringify({ "name": "both", "main": "cjs.js", "module": "esm.js" }),
		"/workspace/node_modules/both/cjs.js": "module.exports = { 'parse': () => 'cjs' };",
		"/workspace/node_modules/both/esm.js": "export default { 'parse': () => 'esm' };",
		"/workspace/node_modules/esm-only/package.json": JSON.stringify({ "name": "esm-only", "module": "esm.js" }),
		"/workspace/node_modules/esm-only/esm.js": "export const which = 'esm';"
	});

	assert.equal(runtime.execute("module.exports = require('both').parse();", "/workspace/main.js").exports, "cjs");
	assert.equal(runtime.execute("module.exports = require('esm-only').which;", "/workspace/main.js").exports, "esm");
});

test("browserField: false resolves a package as Node does — its main, not its browser build", () => {
	const files = {
		"/workspace/node_modules/dual/package.json": JSON.stringify({ "name": "dual", "main": "node.js", "browser": "browser.js" }),
		"/workspace/node_modules/dual/node.js": "module.exports = 'node';",
		"/workspace/node_modules/dual/browser.js": "module.exports = 'browser';"
	};

	assert.equal(runtimeWith(files).execute("module.exports = require('dual');", "/workspace/main.js").exports, "browser", "by default, the browser build");
	assert.equal(runtimeWith(files, { "browserField": false }).execute("module.exports = require('dual');", "/workspace/main.js").exports, "node");
});
