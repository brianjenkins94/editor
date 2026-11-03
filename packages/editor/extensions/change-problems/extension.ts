/**
 * A change's problems' extension: what carries its TypeScript server plugin (ts-plugin.js, `typescriptServerPlugins` in
 * its manifest), which the TypeScript extension loads into its server. Core asks the plugin (workbench/code-problems.ts,
 * through `typescript.tsserverRequest`); there's nothing for this extension to do once it's loaded.
 */
export function activate(): void { /* the plugin is the TypeScript extension's to load */ }
