/**
 * External-`typescript` shim for the eslint ENGINE build (eslint.engine.config.ts aliases `typescript` here).
 *
 * The engine runs inside the tsserver plugin, which already has the full `typescript` loaded — so rather than
 * bundle our own ~6MB copy, the plugin sets `globalThis.__eslintTs = modules.typescript` (see ts-plugin.js)
 * BEFORE importing the engine, and every reference to `typescript` in the chain resolves here to that instance.
 *
 * CommonJS on purpose (`module.exports = …`, NOT `export default`): `@typescript-eslint/parser` reaches the
 * compiler via `const ts = require("typescript")` — a NAMESPACE require. A CJS module makes both that
 * (`require("typescript")` → the ts namespace) and any `import ts from "typescript"` (default = module.exports
 * via interop) resolve to the same object. An ESM `export default` would give the namespace-require caller
 * `{ default: ts }`, so `ts.SyntaxKind` would be undefined.
 */
module.exports = globalThis.__eslintTs;
