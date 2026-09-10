// Mini-grammar demonstration of UPSTREAM_BUGS.md W6: an `eatMatch` of a node matcher that carries a literal
// (`<A '<' />`) is NOT backtracked when the production fails after that literal — the source stays past the `<`
// and a span opened inside the failed production stays on the stack. Plain node matchers backtrack fine.
// Usage: node test/backtrack-probe.mjs   (from the repo root). Expected on the pinned runtime: the first three
// lines OK, the last three FAIL.
import { freezeClass } from "@bablr/agast-helpers/object";
import { printSource } from "@bablr/agast-helpers/tree";
import { eat, eatMatch, endSpan, m, match, startSpan } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import { enhance, TypeScriptAtrivial } from "../lib/grammar";

function run(label, Cls, input) {
	freezeClass(Cls);
	try {
		const out = printSource(treeParse(enhance(Cls), m`<Program />`, input));

		console.log(label.padEnd(62), JSON.stringify(input).padEnd(6), out === input ? "OK" : "DIFF " + JSON.stringify(out));
	} catch (e) { console.log(label.padEnd(62), JSON.stringify(input).padEnd(6), "FAIL", e.message.split("\n")[0]); }
}

run("control: eatMatch(A) fails on its FIRST token, then B", class extends TypeScriptAtrivial {
	*Program() { yield eatMatch(m`a$: <A />`); yield eat(m`b$: <B />`); }
	*A() { yield eat(m`open*: <* '{' />`); }
	*B() { yield eat(m`t*: <*Tok />`); } *Tok() { yield eat(m`/<\(/`); }
}, "<(");
run("eatMatch(A) eats \"<\" then fails on a token, then B", class extends TypeScriptAtrivial {
	*Program() { yield eatMatch(m`a$: <A />`); yield eat(m`b$: <B />`); }
	*A() { yield eat(m`open*: <* '<' />`); yield eat(m`w$: <*Word />`); }
	*Word() { yield eat(m`/[a-z]+/`); }
	*B() { yield eat(m`t*: <*Tok />`); } *Tok() { yield eat(m`/<\(/`); }
}, "<(");
run("same via a cover: Program eats <_X />, X does the eatMatch", class extends TypeScriptAtrivial {
	*Program() { yield eat(m`x+$: <_X />`); }
	*X() { yield eatMatch(m`<A />`); yield eat(m`<B />`); }
	*A() { yield eat(m`open*: <* '<' />`); yield eat(m`w$: <*Word />`); }
	*Word() { yield eat(m`/[a-z]+/`); }
	*B() { yield eat(m`t*: <*Tok />`); } *Tok() { yield eat(m`/<\(/`); }
}, "<(");
run("node matcher WITH literal: eatMatch(<A \"<\" />) fails inside", class extends TypeScriptAtrivial {
	*Program() { yield eatMatch(m`a$: <A '<' />`); yield eat(m`b$: <B />`); }
	*A() { yield eat(m`open*: <* '<' />`); yield eat(m`w$: <*Word />`); }
	*Word() { yield eat(m`/[a-z]+/`); }
	*B() { yield eat(m`t*: <*Tok />`); } *Tok() { yield eat(m`/<\(/`); }
}, "<(");
run("same, with a >-guarded span opened inside A before failing", class extends TypeScriptAtrivial {
	*Program() {
		yield eatMatch(m`a$: <A '<' />`); const g = yield match(m`/$/`);

		if (g) { throw new Error("leaked > guard"); } yield eat(m`b$: <B />`);
	}

	*A() { yield eat(m`open*: <* '<' />`); yield startSpan("Bare", ">"); yield eat(m`w$: <*Word />`); yield endSpan(); }
	*Word() { yield eat(m`/[a-z]+/`); }
	*B() { yield eat(m`t*: <*Tok />`); } *Tok() { yield eat(m`/<>/`); }
}, "<>");
run("inside an intercept-style generator: hook eatMatch then base instr", class extends TypeScriptAtrivial {
	*Program() { yield* (function *() { yield eatMatch(m`a$: <A '<' />`); })(); yield eat(m`b$: <B />`); }
	*A() { yield eat(m`open*: <* '<' />`); yield startSpan("Bare", ">"); yield eat(m`w$: <*Word />`); yield endSpan(); }
	*Word() { yield eat(m`/[a-z]+/`); }
	*B() { yield eat(m`t*: <*Tok />`); } *Tok() { yield eat(m`/<\(/`); }
}, "<(");
