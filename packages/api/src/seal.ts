import { base64url } from "jose";

/**
 * Sealing a secret at rest (GitHub's tokens, in a Grant): AES-GCM under TOKEN_KEK, bound to `context` (the grant's id) as
 * additional data, so a sealed value moved to another grant won't open. Sealed as `v1.<iv>.<ciphertext>`: the version
 * names the key, so it can rotate.
 */

function key(kek: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", base64url.decode(kek), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(kek: string, plaintext: string, context: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ "name": "AES-GCM", "iv": iv, "additionalData": new TextEncoder().encode(context) }, await key(kek), new TextEncoder().encode(plaintext));

	return `v1.${base64url.encode(iv)}.${base64url.encode(new Uint8Array(sealed))}`;
}

export async function open(kek: string, sealed: string, context: string): Promise<string> {
	const [version, iv, ciphertext] = sealed.split(".");

	if (version !== "v1" || iv === undefined || ciphertext === undefined) {
		throw new TypeError("not a value this key sealed");
	}

	const plaintext = await crypto.subtle.decrypt({ "name": "AES-GCM", "iv": base64url.decode(iv), "additionalData": new TextEncoder().encode(context) }, await key(kek), base64url.decode(ciphertext));

	return new TextDecoder().decode(plaintext);
}
