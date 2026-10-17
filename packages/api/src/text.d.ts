/** Wrangler's default module rules import these as text (the emails' bodies, src/*-code.*), and .wasm as a compiled
 *  WebAssembly module (Argon2's, src/password.ts). */
declare module "*.html" {
	const text: string;

	export default text;
}

declare module "*.txt" {
	const text: string;

	export default text;
}

declare module "*.wasm" {
	const module: WebAssembly.Module;

	export default module;
}
