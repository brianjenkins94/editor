/** The worker-pod extension, bundled to a browser CommonJS file served beside the entry: its path (see bundledExtension in build.ts). */
declare module "worker-pod:extension" {
	const path: string;

	export default path;
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

/** The eslint extension, bundled to a browser CommonJS file served beside the entry: its path (see bundledExtension
 *  in build.ts) — a TS server plugin that lints inside tsserver, reusing tsserver's own typescript. */
declare module "eslint:extension" {
	const path: string;

	export default path;
}

/** The insights extension (every run's coverage in the gutter; the metrics monitor), bundled like the others: its path. */
declare module "insights:extension" {
	const path: string;

	export default path;
}

/** The event-sheet extension, bundled like the others: its path. */
declare module "event-sheet:extension" {
	const path: string;

	export default path;
}

/** The event sheet's webview script (served beside the entry; the extension inlines it into its webview): its path. */
declare module "event-sheet:view" {
	const path: string;

	export default path;
}

/** The running extension (what's running, from VS Code's public API), bundled like the others: its path. */
declare module "running:extension" {
	const path: string;

	export default path;
}

/** The worker-pod cspell language server bundled to an ESM string (imported by server-host, run by almostnode). */
declare module "worker-pod:page-tap" {
	const code: string;

	export default code;
}

declare module "worker-pod:worker-tap" {
	const code: string;

	export default code;
}

declare module "worker-pod:server-node" {
	const code: string;

	export default code;
}

/** Vite `?raw` imports — file contents as a string (used to register the TS server plugin source). */
declare module "*?raw" {
	const content: string;

	export default content;
}
