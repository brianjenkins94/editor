/** Wrangler's default module rules import these as text (the email's bodies, src/email-code.*). */
declare module "*.html" {
	const text: string;

	export default text;
}

declare module "*.txt" {
	const text: string;

	export default text;
}
