// Regex-VM probe: does DSL regex R match input I (as a whole token)?   node test/rx.mjs '/a\<b/' 'a<b' [...pairs]
import { freezeClass } from "@bablr/agast-helpers/object";
import { printSource } from "@bablr/agast-helpers/tree";
import { eat, m } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import { enhance, mRaw, TypeScriptAtrivial } from "../lib/grammar.js";

const args = process.argv.slice(2);

for (let i = 0; i + 1 < args.length; i += 2) {
	const [rx, input] = [args[i], args[i + 1]];
	let matcher;

	try { matcher = mRaw(rx); } catch (e) { console.log(rx.padEnd(40), "DSL parse error:", e.message.split("\n")[0]); continue; }
	class Rx extends TypeScriptAtrivial { *Program() { yield eat(m`word$: <*Word />`); } *Word() { yield eat(matcher); } }
	freezeClass(Rx);
	try {
		const out = printSource(treeParse(enhance(Rx), m`<Program />`, input));

		console.log(rx.padEnd(40), JSON.stringify(input).padEnd(16), out === input ? "OK" : "DIFF " + JSON.stringify(out));
	} catch (e) { console.log(rx.padEnd(40), JSON.stringify(input).padEnd(16), "FAIL", e.message.split("\n")[0]); }
}
