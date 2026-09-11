/** The hello extension bundled to a browser CommonJS string (see the plugin in entry.config.ts). */
declare module "hello:extension" {
	const code: string;
	export default code;
}

/** The preflight extension bundled to a browser CommonJS string (see the plugin in entry.config.ts). */
declare module "preflight:extension" {
	const code: string;
	export default code;
}

/** Vite `?raw` imports — file contents as a string (used to register the TS server plugin source). */
declare module "*?raw" {
	const content: string;
	export default content;
}
