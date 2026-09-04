import { test } from "node:test";
import { assertDifferential } from "./harness.ts";
import { STARTER_CASES } from "./cases.ts";
import { S2_CASES } from "./cases-s2.ts";
import { CLASS_CASES } from "./cases-classes.ts";

for (const code of [...STARTER_CASES, ...S2_CASES, ...CLASS_CASES]) {
	test(`differential: ${code.replace(/\s+/g, " ").slice(0, 70)}`, () => {
		assertDifferential(code);
	});
}
