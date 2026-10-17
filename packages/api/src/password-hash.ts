import { hashRaw } from "@hallaxius/argon2w";

/**
 * Passwords' rules and hashing (SIGN-IN.md, "Passwords"; src/password.ts uses them): Pilcrow's rules, and Argon2id at
 * OWASP's baseline through @hallaxius/argon2w (Argon2's reference implementation as WebAssembly, built for Workers: its
 * module is imported, which the runtime allows, rather than compiled at runtime, which it doesn't; src/password.ts hands
 * it over; in Node it reads it from disk). Only its raw Argon2id is used: the PHC string and the constant-time comparison
 * are ours. Nothing here touches the Workers runtime, so the tests check it against Node's own Argon2id.
 */

/** Argon2id, OWASP's baseline: memory in KiB, passes, lanes, and the hash's length in bytes. */
export const ARGON2 = { "memoryCost": 19_456, "timeCost": 2, "parallelism": 1, "hashLength": 32 };

/** What's wrong with a password, by the rules, or nothing. */
export function passwordProblem(password: string): string | undefined {
	return password.length < 10 ? "shorter than 10 characters"
		: password.length > 100 ? "longer than 100 characters"
			: /[^\x20-\x7E]/u.test(password) ? "only letters, digits, spaces and the symbols on a US keyboard"
				: password !== password.trim() ? "starts or ends with a space" : undefined;
}

/** base64 without padding, as PHC strings write it. */
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=+$/u, "");

const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/** Equal bytes, compared without stopping at the first difference. */
function same(a: Uint8Array, b: Uint8Array): boolean {
	let difference = a.length ^ b.length;

	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}

	return difference === 0;
}

const derive = async (password: string, salt: Uint8Array, costs: typeof ARGON2): Promise<Uint8Array> => hashRaw(password, { "salt": salt, ...costs });

/** A password's hash, as a PHC string: `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));

	return `$argon2id$v=19$m=${ARGON2.memoryCost},t=${ARGON2.timeCost},p=${ARGON2.parallelism}$${b64(salt)}$${b64(await derive(password, salt, ARGON2))}`;
}

/** Whether `password` is the one `phc` was made from, by the costs it records (so stronger costs later still verify the
 *  old), compared in constant time. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
	const [, kind, , parameters = "", salt = "", hash = ""] = phc.split("$");
	const costs = Object.fromEntries(parameters.split(",").map((pair) => pair.split("=")).map(([key, value]) => [key, Number(value)]));
	const expected = unb64(hash);

	if (kind !== "argon2id" || expected.length === 0) {
		return false;
	}

	return same(await derive(password, unb64(salt), { "memoryCost": costs["m"] ?? ARGON2.memoryCost, "timeCost": costs["t"] ?? ARGON2.timeCost, "parallelism": costs["p"] ?? ARGON2.parallelism, "hashLength": expected.length }), expected);
}
