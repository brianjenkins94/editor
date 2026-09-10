import { readFileSync } from "node:fs";
import { evaluateReturn, printSource as streamPrintSource } from "@bablr/agast-helpers/stream";
import { LiteralTag, OpenNodeTag } from "@bablr/agast-helpers/symbols";
import { parseTag, parseTagType, printPrettyCSTML, printSource } from "@bablr/agast-helpers/tree";

import { m } from "@bablr/helpers/grammar";
import { streamParse, treeParse } from "bablr";

const { "default": TypeScript } = await import(new URL(process.env.GRAMMAR ?? "../lib/grammar.ts", import.meta.url).href);

let src = process.argv[2] ?? "const x = 1";

if (src.startsWith("@")) {
	src = readFileSync(src.slice(1), "utf8");
}

const prod = process.argv[3] ?? "Program";
let matcher;

if (prod === "Expression") {
	matcher = m`<Expression />`;
} else if (prod === "Statement") {
	matcher = m`<Statement />`;
} else {
	matcher = m`<Program />`;
}

const t0 = performance.now();

try {
	const tree = treeParse(TypeScript, matcher, src);
	const out = printSource(tree);

	console.log(`[tree] equal=${out === src} ${(performance.now() - t0).toFixed(0)}ms len=${src.length}` + (out === src ? "" : ` out=${JSON.stringify(out).slice(0, 200)}`));
	if (process.env.SHOW) {
		console.log(printPrettyCSTML(tree));
	}
} catch (error) {
	if (process.env.PREFIX) {
		let text = "";

		try {
			for (const tag of streamParse(TypeScript, matcher, src)) {
				const type = parseTagType(tag);

				if (type === LiteralTag) {
					text += parseTag(tag).value;
				} else if (type === OpenNodeTag) {
					const lv = parseTag(tag).value.literalValue;

					text += lv || "";
				}
			}
		} catch {}

		const pos = text.length;
		const line = src.slice(0, pos).split("\n").length;

		console.log(`[prefix] consumed ${pos} chars (line ${line}): …${JSON.stringify(src.slice(Math.max(0, pos - 80), pos))} ⟨⟩ ${JSON.stringify(src.slice(pos, pos + 120))}`);
	}

	console.log(`[tree] ERROR ${(performance.now() - t0).toFixed(0)}ms ${String(error.message).split("\n")[0]}`);
	if (process.env.STACK) {
		console.log(error.stack);
	}
}

if (process.env.STREAM) {
	try {
		const tags = streamParse(TypeScript, matcher, src);
		const out = evaluateReturn(streamPrintSource(tags));

		console.log(`[stream] equal=${out === src} out=${JSON.stringify(out).slice(0, 200)}`);
	} catch (error) {
		console.log(`[stream] ERROR ${String(error.message).split("\n")[0]}`);
	}
}
