/**
 * Passwords (src/password-hash.ts): a hash stored by the earlier library still verifies, and the rules a new password
 * is held to. Pure, so it runs anywhere — in the editor's debugger too. password.test.ts tests sign-in with passwords in
 * workerd, and the hash against Node's own Argon2id (Node the reference).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { passwordProblem, verifyPassword } from "../src/password-hash.ts";

test("a hash stored before the switch to @noble/hashes (made by @hallaxius/argon2w, 2026-10-21) still verifies", async () => {
	const stored = "$argon2id$v=19$m=19456,t=2,p=1$Rzb4ru0fdDfjsPFnIj5xYQ$AQYFlycaDrSxJCcV0qm1ZaH6On/C/dnnHiVo/YaZ/GY";

	assert.equal(await verifyPassword("correct horse battery staple", stored), true);
	assert.equal(await verifyPassword("correct horse battery stapl", stored), false);
});

test("the rules: 10 to 100 printable ASCII characters, no space at either end, said plainly", () => {
	assert.equal(passwordProblem("short"), "shorter than 10 characters");
	assert.equal(passwordProblem("x".repeat(101)), "longer than 100 characters");
	assert.equal(passwordProblem("pässwörter-lang"), "only letters, digits, spaces and the symbols on a US keyboard");
	assert.equal(passwordProblem(" leading space ok?"), "starts or ends with a space");
	assert.equal(passwordProblem("a perfectly fine passphrase"), undefined);
});
