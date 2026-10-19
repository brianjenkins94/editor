/**
 * Web Awesome for the sign-in pages (public/sign-in.html, public/passkey.html), as two of their own files: the pages load
 * nothing but this origin's (SIGN-IN.md), so the components they use and Web Awesome's stylesheet are bundled into
 * public/webawesome.js and public/webawesome.css. wrangler runs this before `dev` and `deploy` (wrangler.jsonc's `build`);
 * both files are build output, not committed.
 *
 *   node scripts/webawesome.ts
 */
import { build } from "esbuild";

/** The components the pages use. */
const COMPONENTS = ["button", "callout", "card", "checkbox", "input"];

const root = new URL("..", import.meta.url).pathname;

await build({
	"stdin": { "contents": COMPONENTS.map((name) => `import "@awesome.me/webawesome/dist/components/${name}/${name}.js";`).join("\n"), "resolveDir": root, "sourcefile": "webawesome.js" },
	"bundle": true,
	"format": "esm",
	"minify": true,
	"legalComments": "none",
	"outfile": root + "public/webawesome.js",
	"logLevel": "warning"
});

// Its layers, native styles, utility classes and default theme.
await build({
	"entryPoints": [root + "node_modules/@awesome.me/webawesome/dist/styles/webawesome.css"],
	"bundle": true,
	"minify": true,
	"outfile": root + "public/webawesome.css",
	"logLevel": "warning"
});
