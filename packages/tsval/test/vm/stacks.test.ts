// A program's own stack (src/stacks.ts): what each case says is what Node says of the same program (run as a module,
// its file's name aside), but for the frames of Node's own loader below it and of built-ins (`at JSON.parse`).
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

/** Run `lines` as /w/prog.ts on an event loop to its end; what it logged. */
async function logs(lines: string[]): Promise<unknown[]> {
	const logged: unknown[] = [];
	const { vm } = createVM(lines.join("\n"), {
		"fileName": "/w/prog.ts",
		"globals": {
			"log": (value: unknown) => { logged.push(value); }
		},
		"eventLoop": { "pace": "fast" }
	});

	while (!vm.finished) {
		vm.runToBreakpoint();

		while (vm.idle) {
			await vm.whenSettled();
			vm.runToBreakpoint();
		}
	}

	return logged;
}

test("stacks: an error's stack is the program's frames — a function, a method by its class, the top level — where each is", async () => {
	assert.deepStrictEqual(await logs([
		"function plain() { return new Error(\"plain\").stack; }",
		"class Box { method() { return plain(); } }",
		"log(new Box().method());"
	]), [
		[
			"Error: plain",
			"    at plain (/w/prog.ts:1:27)",
			"    at Box.method (/w/prog.ts:2:31)",
			"    at /w/prog.ts:3:15"
		].join("\n")
	]);
});

test("stacks: a class extending Error starts where it's made, its constructors left out, as V8's does", async () => {
	assert.deepStrictEqual(await logs([
		"class Mine extends Error { constructor(m) { super(m); } }",
		"log(new Mine(\"mine\").stack);"
	]), [
		["Error: mine", "    at /w/prog.ts:2:5"].join("\n")
	]);
});

test("stacks: an await goes back to what's waiting on it, `at async`", async () => {
	assert.deepStrictEqual(await logs([
		"async function inner() { await null; return new Error(\"later\").stack; }",
		"async function outer() { return await inner(); }",
		"outer().then(log);"
	]), [
		["Error: later", "    at inner (/w/prog.ts:1:45)", "    at async outer (/w/prog.ts:2:33)"].join("\n")
	]);
});

test("stacks: Error.prepareStackTrace is given call sites as V8's — each one's class, its name, whether it's waiting", async () => {
	// (fs-boundaries.test's vscodeCaller: who in VS Code asked, the class past its file service, through awaits)
	const before = Error.prepareStackTrace;
	const [sites] = await logs([
		"class FileService { async resolve(read) { await Promise.resolve(); return read(); } }",
		"class ExplorerService { async refresh(files, read) { return await files.resolve(read); } }",
		"function caller() {",
		"\tconst prepare = Error.prepareStackTrace;",
		"\tError.prepareStackTrace = (_, sites) => sites;",
		"\tlet sites;",
		"\ttry { sites = new Error(\"caller\").stack; } finally { Error.prepareStackTrace = prepare; }",
		"\treturn sites.map((site) => [site.getTypeName(), site.getFunctionName(), site.isAsync(), site.getLineNumber()]);",
		"}",
		"new ExplorerService().refresh(new FileService(), () => caller()).then(log);"
	]);

	assert.deepStrictEqual(sites, [
		[null, "caller", false, 7],
		[null, null, false, 10],
		["FileService", "resolve", false, 1],
		["ExplorerService", "refresh", true, 2]
	]);
	assert.strictEqual(Error.prepareStackTrace, before, "the host's own is as it was");
});

test("stacks: captureStackTrace leaves out the function it's given and what's above it; stackTraceLimit is kept to", async () => {
	assert.deepStrictEqual(await logs([
		"function hidden() { const o = {}; Error.captureStackTrace(o, hidden); return o.stack; }",
		"function shown() { return hidden(); }",
		"log(shown());",
		"const limit = Error.stackTraceLimit;",
		"Error.stackTraceLimit = 1;",
		"function deep() { return new Error(\"one\").stack; }",
		"function deeper() { return deep(); }",
		"log(deeper());",
		"Error.stackTraceLimit = limit;"
	]), [
		["Error", "    at shown (/w/prog.ts:2:27)", "    at /w/prog.ts:3:5"].join("\n"),
		["Error: one", "    at deep (/w/prog.ts:6:26)"].join("\n")
	]);
});

test("stacks: a built-in's error the program catches has its frames; told when first read, and set like any property", async () => {
	assert.deepStrictEqual(await logs([
		"function parses() { try { JSON.parse(\"{\"); } catch (e) { return e.stack.split(\"\\n\").slice(1).join(\"\\n\"); } }",
		"log(parses());",
		"const set = new Error(\"set\"); set.stack = \"mine\"; log(set.stack);",
		"const told = new Error(\"before\"); told.message = \"after\"; log(told.stack.split(\"\\n\")[0]);"
	]), ["    at parses (/w/prog.ts:1:32)\n    at /w/prog.ts:2:5", "mine", "Error: after"]);
});
