/**
 * Authenticator-app codes (SIGN-IN.md, "MFA, optional"; C5): TOTP, RFC 6238 over RFC 4226's HOTP, as every authenticator
 * app reads an `otpauth://` URI: HMAC-SHA-1, 6 digits, 30-second steps. A code is accepted for its step or one either
 * side (a clock a little off), and each step only once (`last` is the newest step used). Recovery codes are the way in
 * when the app is lost. Nothing here touches the Workers runtime, so the tests check it against the RFC's own vectors.
 */

export const DIGITS = 6;

export const PERIOD = 30;

/** RFC 4648 base32, no padding: what an `otpauth://` URI's secret is written in. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
	let bits = "";

	for (const byte of bytes) {
		bits += byte.toString(2).padStart(8, "0");
	}

	return (bits.match(/.{1,5}/gu) ?? []).map((chunk) => BASE32[Number.parseInt(chunk.padEnd(5, "0"), 2)]).join("");
}

export function unbase32(text: string): Uint8Array {
	const bits = [...text.toUpperCase().replaceAll(/[\s=]/gu, "")].map((character) => BASE32.indexOf(character).toString(2).padStart(5, "0")).join("");

	return Uint8Array.from(bits.match(/.{8}/gu) ?? [], (byte) => Number.parseInt(byte, 2));
}

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommendation for SHA-1). */
export const newSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(20));

/** HOTP (RFC 4226): the code for `counter`, `digits` long. */
export async function hotp(secret: Uint8Array, counter: number, digits = DIGITS): Promise<string> {
	const message = new Uint8Array(8);

	new DataView(message.buffer).setBigUint64(0, BigInt(counter));

	const key = await crypto.subtle.importKey("raw", secret, { "name": "HMAC", "hash": "SHA-1" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
	const offset = (mac[mac.length - 1] ?? 0) & 0x0F;
	const binary = new DataView(mac.buffer).getUint32(offset) & 0x7F_FF_FF_FF;

	return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The 30-second step a moment falls in. */
export const stepAt = (now: number): number => Math.floor(now / 1000 / PERIOD);

/** The step `code` belongs to, if it's the code for the step now or one either side, and newer than `last` (each step
 *  is good once); otherwise undefined. */
export async function verifyTotp(secret: Uint8Array, code: string, now: number, last = -1): Promise<number | undefined> {
	if (!/^\d{6}$/u.test(code)) {
		return undefined;
	}

	const step = stepAt(now);

	for (const candidate of [step - 1, step, step + 1]) {
		if (candidate > last && await hotp(secret, candidate) === code) {
			return candidate;
		}
	}

	return undefined;
}

/** The URI an authenticator app reads from the QR code. */
export const otpauthUri = (secret: Uint8Array, account: string): string => `otpauth://totp/${encodeURIComponent(`unusually good:${account}`)}?${new URLSearchParams({ "secret": base32(secret), "issuer": "unusually good", "algorithm": "SHA1", "digits": String(DIGITS), "period": String(PERIOD) })}`;

/** Recovery codes: 10 of them, each 10 symbols of 32 (no I, O, 0 or 1), shown as `ABCDE-FGHJK`: 50 bits apiece. */
const RECOVERY = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const RECOVERY_CODES = 10;

export const newRecoveryCodes = (): string[] => Array.from({ "length": RECOVERY_CODES }, () => {
	const symbols = [...crypto.getRandomValues(new Uint8Array(10))].map((byte) => RECOVERY[byte % RECOVERY.length]).join("");

	return `${symbols.slice(0, 5)}-${symbols.slice(5)}`;
});

/** A recovery code as typed, compared: case, the dash and spaces don't matter. */
export const typedRecovery = (code: string): string => code.toUpperCase().replaceAll(/[\s-]/gu, "");

/** Whether it looks like a recovery code (typed first), not an app's. */
export const isRecoveryCode = (code: string): boolean => /^[A-HJ-NP-Z2-9]{10}$/u.test(code);
