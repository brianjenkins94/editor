// WebAuthn's options and answers, to and from the JSON the API speaks (@simplewebauthn/server's): its byte fields as
// base64url. The sign-in page (a passkey sign-in) and the passkey page (adding one) both use it.

const bytes = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), (character) => character.charCodeAt(0));

const text = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const credentials = (list = []) => list.map((credential) => ({ ...credential, "id": bytes(credential.id) }));

/** Whether this browser can do passkeys at all. */
export const supported = () => typeof PublicKeyCredential === "function" && typeof navigator.credentials?.create === "function";

/** A new passkey, from the API's registration options: the answer as JSON. */
export async function create(options) {
	const made = await navigator.credentials.create({ "publicKey": { ...options, "challenge": bytes(options.challenge), "user": { ...options.user, "id": bytes(options.user.id) }, "excludeCredentials": credentials(options.excludeCredentials) } });

	return JSON.stringify({
		"id": made.id,
		"rawId": text(made.rawId),
		"type": made.type,
		"authenticatorAttachment": made.authenticatorAttachment ?? undefined,
		"clientExtensionResults": made.getClientExtensionResults(),
		"response": { "clientDataJSON": text(made.response.clientDataJSON), "attestationObject": text(made.response.attestationObject), "transports": made.response.getTransports?.() ?? [] }
	});
}

/** A passkey's answer to the API's sign-in options, as JSON. */
export async function get(options) {
	const used = await navigator.credentials.get({ "publicKey": { ...options, "challenge": bytes(options.challenge), "allowCredentials": credentials(options.allowCredentials) } });

	return JSON.stringify({
		"id": used.id,
		"rawId": text(used.rawId),
		"type": used.type,
		"authenticatorAttachment": used.authenticatorAttachment ?? undefined,
		"clientExtensionResults": used.getClientExtensionResults(),
		"response": { "clientDataJSON": text(used.response.clientDataJSON), "authenticatorData": text(used.response.authenticatorData), "signature": text(used.response.signature), "userHandle": used.response.userHandle === null ? undefined : text(used.response.userHandle) }
	});
}
