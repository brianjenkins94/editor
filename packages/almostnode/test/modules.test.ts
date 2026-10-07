/**
 * The module system a host shares (MODULES.md): almostnode resolves — built-ins, packages, the program's own files — and
 * a host may evaluate the program's files its own way (`evaluateProgram`), give the program's code built-ins of its own
 * (`builtinFor`), and put a module it evaluated in the cache (`register`).
 */
import * as assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// (almostnode's sources import each other without extensions: see extensionless.mjs.)
register("./extensionless.mjs", import.meta.url);

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
