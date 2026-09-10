/** The hello extension bundled to a browser CommonJS string (see the plugin in entry.config.ts). */
declare module "hello:extension" {
	const code: string;
	export default code;
}
