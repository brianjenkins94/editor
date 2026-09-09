import { test } from "node:test";
import { CLASS_CASES } from "./cases-classes.ts";
import { S2_CASES } from "./cases-s2.ts";
import { ASYNC_CASES, GENERATOR_CASES } from "./cases-s3.ts";
import { STARTER_CASES } from "./cases.ts";
import { assertDifferential, assertDifferentialAsync } from "./harness.ts";

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
