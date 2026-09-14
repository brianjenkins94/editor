/**
 * External-`typescript` shim for the capabilities CANARY engine build (build.ts pass 3c aliases `typescript` here).
 *
 * The canary runs INSIDE the tsserver plugin (ts-plugin.js), which already has the full `typescript` loaded — so
 * rather than bundle our own ~7MB copy (tsval imports `import ts from "typescript"`), the plugin sets
 * `globalThis.__capabilitiesTs = modules.typescript` BEFORE importing the engine, and every `typescript` import in
 * the chain (tsval's frontend/vm, canary.ts) resolves here to that instance. Same trick as extensions/eslint.
 *
 * CommonJS on purpose (`module.exports = …`, NOT `export default`): default imports (`import ts from "typescript"`)
 * get `module.exports` via interop, so `ts.SyntaxKind` is the real namespace. An ESM `export default` would hand a
 * `require("typescript")` caller `{ default: ts }` instead.
 */
module.exports = globalThis.__capabilitiesTs;
