import { test } from "node:test";
import { assertDifferential } from "./harness.ts";
import { STARTER_CASES } from "./cases.ts";

for (const code of STARTER_CASES) {
	test(`differential: ${code.replace(/\s+/g, " ").slice(0, 70)}`, () => {
		assertDifferential(code);
	});
}
