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

/** The user's eslint preset as data (see extensions/eslint/preset-build.ts). */
declare module "eslint:preset" {
	const preset: { "source": string; "version": string; "blocks": unknown[] };

	export default preset;
}

/** One loader per eslint preset plugin, each its own chunk (see extensions/eslint/preset-build.ts). */
declare module "eslint:preset-plugins" {
	const loaders: Record<string, () => Promise<{ "rules": Record<string, unknown> }>>;

	export default loaders;
}

/** settings-defaults.jsonc, parsed — registered as the editor's configuration defaults (see snapshot.ts). */
declare module "editor:settings-defaults" {
	const defaults: Record<string, unknown>;

	export default defaults;
}

/** The eslint extension bundled to a browser CommonJS string (see bundledExtension("eslint") in build.ts) —
 *  a TS server plugin that lints inside tsserver, reusing tsserver's own typescript. */
declare module "eslint:extension" {
	const code: string;

	export default code;
}

/** The worker-pod cspell language server bundled to an ESM string (imported by server-host, run by almostnode). */
declare module "worker-pod:server-node" {
	const code: string;

	export default code;
}

/** Vite `?raw` imports — file contents as a string (used to register the TS server plugin source). */
declare module "*?raw" {
	const content: string;

	export default content;
}
