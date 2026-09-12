/** The hello extension bundled to a browser CommonJS string (see the plugin in entry.config.ts). */
declare module "hello:extension" {
	const code: string;
	export default code;
}

/** The worker-pod extension bundled to a browser CommonJS string (see the plugin in entry.config.ts). */
declare module "worker-pod:extension" {
	const code: string;
	export default code;
}

/** The worker-pod cspell language server bundled to an ESM string (imported by server-host, run by almostnode). */
declare module "worker-pod:server-node" {
	const code: string;
	export default code;
}

/** The worker-pod eslint language server bundled to an ESM string (imported by server-host-eslint, run by almostnode). */
declare module "worker-pod:server-node-eslint" {
	const code: string;
	export default code;
}

/** Vite `?raw` imports — file contents as a string (used to register the TS server plugin source). */
declare module "*?raw" {
	const content: string;
	export default content;
}
