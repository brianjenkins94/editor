/** Each of the editor's extensions (`<name>:extension`): the folder build.ts built it into (bundledExtension), relative to
 *  the workbench, and its manifest — `browser` its entry there, `files` what else is. */
declare module "*:extension" {
	const extension: { "base": string; "manifest": Parameters<typeof import("@brianjenkins94/monaco-vscode-api/main").registerExtension>[0] & { "browser": string; "files"?: string[] } };

	export default extension;
}

/** dockview's stylesheet — the `dockview` package's dist/styles/dockview.css (see dockviewCssPlugin in build.ts). */
declare module "dockview:css" {
	const css: string;

	export default css;
}

/** settings-defaults.jsonc, parsed — registered as the editor's configuration defaults (see snapshot.ts). */
declare module "editor:settings-defaults" {
	const defaults: Record<string, unknown>;

	export default defaults;
}

declare module "previews:page-tap" {
	const code: string;

	export default code;
}

declare module "previews:worker-tap" {
	const code: string;

	export default code;
}

/** The cspell language server bundled to an ESM string (imported by server-host, run by almostnode). */
declare module "cspell:server-node" {
	const code: string;

	export default code;
}

/** Vite `?raw` imports — file contents as a string (used to register the TS server plugin source). */
declare module "*?raw" {
	const content: string;

	export default content;
}
