// node test/probe-all.mjs test/cases-s1.txt  — one snippet per line; prints only failures unless VERBOSE
import { readFileSync } from "node:fs";
import { printSource } from "@bablr/agast-helpers/tree";
import { m } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import TypeScript from "../lib/grammar";

const lines = readFileSync(process.argv[2], "utf8").split("\n").filter((line) => line.trim() && !line.startsWith("#"));
let pass = 0;

for (const src of lines) {
	try {
		const out = printSource(treeParse(TypeScript, m`<Program />`, src));

		if (out === src) {
			pass += 1;
			if (process.env.VERBOSE) {
				console.log("ok   ", src);
			}
		} else {
			console.log("DIFF ", src, "→", JSON.stringify(out));
		}
	} catch (error) {
		console.log("FAIL ", src, "—", String(error.message).split("\n")[0]);
	}
}

console.log(`${pass}/${lines.length} pass`);
