// Regex-VM probe: does DSL regex R match input I (as a whole token)?   node test/rx.mjs '/a\<b/' 'a<b' [...pairs]
import { freezeClass } from "@bablr/agast-helpers/object";
import { printSource } from "@bablr/agast-helpers/tree";
import { eat, m } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import { enhance, mRaw, TypeScriptAtrivial } from "../lib/grammar";

const args = process.argv.slice(2);

for (let index = 0; index + 1 < args.length; index += 2) {
	const [rx, input] = [args[index], args[index + 1]];
	let matcher;
	let parseFailed = false;

	try {
		matcher = mRaw(rx);
	} catch (error) {
		console.log(rx.padEnd(40), "DSL parse error:", error.message.split("\n")[0]);
		parseFailed = true;
	}

	if (!parseFailed) {
		class Rx extends TypeScriptAtrivial {
			*Program() {
				yield eat(m`word$: <*Word />`);
			}

			*Word() {
				yield eat(matcher);
			}
		}
		freezeClass(Rx);
		try {
			const out = printSource(treeParse(enhance(Rx), m`<Program />`, input));

			console.log(rx.padEnd(40), JSON.stringify(input).padEnd(16), out === input ? "OK" : "DIFF " + JSON.stringify(out));
		} catch (error) {
			console.log(rx.padEnd(40), JSON.stringify(input).padEnd(16), "FAIL", error.message.split("\n")[0]);
		}
	}
}
