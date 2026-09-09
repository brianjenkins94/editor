import { test } from "node:test";
import { assertDifferential, assertDifferentialAsync } from "./harness.ts";
import { STARTER_CASES } from "./cases.ts";
import { S2_CASES } from "./cases-s2.ts";
import { CLASS_CASES } from "./cases-classes.ts";
import { GENERATOR_CASES, ASYNC_CASES } from "./cases-s3.ts";

for (const code of [...STARTER_CASES, ...S2_CASES, ...CLASS_CASES, ...GENERATOR_CASES]) {
	test(`differential: ${code.replace(/\s+/g, " ").slice(0, 70)}`, () => {
		assertDifferential(code);
	});
}

for (const code of ASYNC_CASES) {
	test(`differential (async): ${code.replace(/\s+/g, " ").slice(0, 62)}`, async () => {
		await assertDifferentialAsync(code);
	});
}
