// Mini-grammar demonstrations of UPSTREAM_BUGS.md W1/W2/W3 (guard mechanics), independent of any language grammar.
// Usage: node test/guard-probe.mjs   (from the repo root)
// Expected on the published runtime: the four controls pass; the W1 (guarded token), W2 (`typeof`) and W3 (guarded
// lookahead) lines FAIL. This is how guards behave; the grammar works around it by giving such tokens their own span.
import { freezeClass } from "@bablr/agast-helpers/object";
import { printSource } from "@bablr/agast-helpers/tree";
import { eat, endSpan, m, match, startSpan } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import { enhance, mRaw, TypeScriptAtrivial } from "../lib/grammar.js";

function run(label, program, word, input) {
	const Cls = class extends TypeScriptAtrivial { *Program() { yield* program(); } *Word() { yield eat(word); } *Punctuator() { yield eat(m`']'`); } *Rest() { yield eat(m`/.*/s`); } };

	freezeClass(Cls);
	try {
		const out = printSource(treeParse(enhance(Cls), m`<Program />`, input));

		console.log(label.padEnd(60), JSON.stringify(input).padEnd(10), out === input ? "OK" : "DIFF " + JSON.stringify(out));
	} catch (e) { console.log(label.padEnd(60), JSON.stringify(input).padEnd(10), "FAIL", e.message.split("\n")[0]); }
}

const W = m`a: <*Word />`; const P = m`close: <*Punctuator />`; const
	R = m`rest: <*Rest />`;

run("W1 string token a]b under ]-guard, then ]", function *() { yield startSpan("X", "]"); yield eat(W); yield endSpan(); yield eat(P); }, m`'a]b'`, "a]b]");
run("W1 regex token /a\\]b/ under ]-guard, then ]", function *() { yield startSpan("X", "]"); yield eat(W); yield endSpan(); yield eat(P); }, mRaw("/a\\]b/"), "a]b]");
run("W1 control: same, unguarded", function *() { yield startSpan("X"); yield eat(W); yield endSpan(); yield eat(P); }, m`'a]b'`, "a]b]");
run("W1 control: token without guard char", function *() { yield startSpan("X", "]"); yield eat(W); yield endSpan(); yield eat(P); }, m`'ab'`, "ab]");

run("W2 guard /\\bof\\b/, token /\\w+/ on typeof", function *() { yield startSpan("X", mRaw("/\\bof\\b/")); yield eat(W); yield endSpan(); }, mRaw("/\\w+/"), "typeof");
run("W2 control: same on \"type\"", function *() { yield startSpan("X", mRaw("/\\bof\\b/")); yield eat(W); yield endSpan(); }, mRaw("/\\w+/"), "type");
run("W2 control: same on \"typeof\" with JS RegExp semantics", function *() {
	const ok = /\w+/y.exec("typeof")[0] === "typeof" && !/\bof\b/y.test("typeof".slice(4));

	yield eat(W);
}, mRaw("/\\w+/"), "typeof");

run("W3 lookahead match(/a,b/) under ,-guard", function *() {
	yield startSpan("X", ","); const la = yield match(m`/a,b/`);

	yield endSpan(); if (!la) { throw new Error("lookahead saw nothing"); } yield eat(R);
}, null, "a,b");
run("W3 control: same lookahead, unguarded", function *() {
	yield startSpan("X"); const la = yield match(m`/a,b/`);

	yield endSpan(); if (!la) { throw new Error("lookahead saw nothing"); } yield eat(R);
}, null, "a,b");
