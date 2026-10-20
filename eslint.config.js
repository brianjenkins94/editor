import { readdirSync } from "node:fs";
import config from "@brianjenkins94/util/eslint";
import webawesome from "./packages/eslint-plugin-webawesome/src/index.js";

// The editor's folders are its realms (packages/editor/ARCHITECTURE.md): a realm imports another realm's code only
// through shared/. A relative import that climbs out of its folder and into another realm's is an error. The
// composition roots (main.tsx, build.ts, dev.ts), the tests and the benches may reach anywhere.
const EDITOR = "packages/editor";
const REALMS = ["app", "shell", "workbench", "workers", "previews", "extensions"];
const EXTENSIONS = readdirSync(new URL(EDITOR + "/extensions", import.meta.url), { "withFileTypes": true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const SOURCES = "*.{ts,tsx,mts,js,mjs}";
// An extension imports core's code from editor-api, never shared/ (FEATURES-AS-EXTENSIONS.md) — but the bridge, which is
// core's.
const STILL_IN_SHARED = new Set(["bridge"]);
// And tsval's privilege (EXTENSION-POINTS.md, 2): almostnode on the workspace's buffer, as core runs it — only these.
const PRIVILEGED = { "tsval": ["workspace-runtime", "zenfs-vfs.js"] };

/** `files` may not climb into any of the `banned` folders — but for `allowed`, shared/ files they may import. */
function realmImports(files, banned, ignores = [], allowed = []) {
	const shared = allowed.length === 0 ? "" : "|shared/(?!(?:" + allowed.map((file) => file.replaceAll(".", "\\.")).join("|") + ")$)";
	const pattern = {
		"regex": "^(?:\\.\\./)+(?:(?:" + banned.join("|") + ")(?:/|$)" + shared + ")",
		"message": "Realms import each other only through shared/, and extensions core's code only through editor-api (packages/editor/ARCHITECTURE.md, \"The realms\"; FEATURES-AS-EXTENSIONS.md)."
	};

	return { "files": files, "ignores": ignores, "rules": { "no-restricted-imports": ["error", { "patterns": [pattern] }] } };
}

const otherRealms = (...own) => REALMS.filter((realm) => !own.includes(realm));
const realmBoundaries = [
	...["app", "shell", "workers", "previews", "shared", "build"].map((realm) => realmImports([`${EDITOR}/${realm}/**/${SOURCES}`], otherRealms(realm))),
	realmImports([`${EDITOR}/workbench/**/${SOURCES}`], otherRealms("workbench"), [`${EDITOR}/workbench/workbench-entry.tsx`]),
	// workbench-entry registers the extensions (their package.json, worker-pod's bridge): its one reach into them.
	realmImports([`${EDITOR}/workbench/workbench-entry.tsx`], otherRealms("workbench", "extensions")),
	// What sits directly in extensions/ is every extension's; an extension reaches no other extension's folder.
	realmImports([`${EDITOR}/extensions/${SOURCES}`], otherRealms("extensions")),
	...EXTENSIONS.map((name) => realmImports([`${EDITOR}/extensions/${name}/**/${SOURCES}`], [...otherRealms("extensions"), ...EXTENSIONS.filter((other) => other !== name), ...STILL_IN_SHARED.has(name) || name in PRIVILEGED ? [] : ["shared"]], [], PRIVILEGED[name]))
];

export default [
	...config,
	{
		// Web Awesome guardrails (see packages/eslint-plugin-webawesome), REPO-WIDE: reach for a `<wa-*>` component
		// when one exists, and author markup as JSX — never native elements or HTML baked into strings. (Vendored/
		// generated paths are already dropped by the global `ignores` above.)
		"files": ["**/*.{ts,tsx,mjs,cjs,js}"],
		// contrib/ is the editor-contrib template: someone else's extension, drawing its own webview however it likes.
		"ignores": ["packages/editor/demo/**", "packages/editor/workbench/Workbench.tsx", "contrib/**"],
		"plugins": { "webawesome": webawesome },
		"rules": {
			"webawesome/prefer-components": "error",
			"webawesome/no-html-in-strings": "error",
			"webawesome/no-css-in-strings": "error",
			"webawesome/no-inline-styles": "error",
			"webawesome/prefer-components-wrapped": "error",
			"webawesome/no-css-imports": "error",
			"webawesome/css-in-js-tokens": "error"
		}
	},
	{
		// The theme package is where the stylesheets live: it adopts its own and Web Awesome's.
		"files": ["packages/theme/**"],
		"rules": { "webawesome/no-css-imports": "off" }
	},
	{
		// The CSS half of the guardrails (packages/theme/PLAN.md §4, §7), in ESLint's CSS language (util's preset registers
		// it): every stylesheet on Web Awesome's tokens, in a layer, reading VS Code's theme only through theme/vscode, not
		// selecting Web Awesome's components, and in the theme package.
		"files": ["**/*.css"],
		"plugins": { "webawesome": webawesome },
		"rules": {
			"css/use-layers": "error",
			// Both are cosmetic where they fall short (Safari still prefixes user-select): text selection, an SVG label's halo.
			"css/use-baseline": ["error", { "allowProperties": ["user-select", "paint-order"] }],
			"webawesome/css-tokens": "error",
			"webawesome/css-no-vscode-variables": "error",
			"webawesome/css-no-wa-selectors": "error",
			"webawesome/css-only-in-theme": "error"
		}
	},
	{
		"files": ["packages/theme/**/*.css"],
		"rules": { "webawesome/css-only-in-theme": "off" }
	},
	{
		// The theme's tokens: unlayered on purpose so they win over Web Awesome's layers, and token definitions, not uses —
		// vscode.css the one place --vscode-* is read. (Its exceptions/ are custom CSS like any other, held to every rule.)
		"files": ["packages/theme/src/theme.css", "packages/theme/src/vscode.css"],
		"rules": { "css/use-layers": "off", "webawesome/css-tokens": "off", "webawesome/css-no-vscode-variables": "off" }
	},
	{
		// The API's sign-in pages bundle Web Awesome themselves (the api doesn't depend on theme): their one sheet centres the
		// card (PLAN.md §7.7).
		"files": ["packages/api/public/sign-in.css"],
		"rules": { "webawesome/css-only-in-theme": "off" }
	},
	...realmBoundaries,
	{
		// `void promise;` is how this repo says "fired on purpose, not awaited" — what no-floating-promises asks for. (Code
		// only: a stylesheet is linted too, by ESLint's CSS language, where JavaScript's rules can't run.)
		"files": ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
		"rules": { "no-void": ["warn", { "allowAsStatement": true }] }
	},
	{
		// CI fails only on ERRORS (util-lint counts errorCount); warnings never fail it. Almost everything is
		// LINTED, including the vendored monaco `main.ts` and the vendored `@bablr/record` shim — their few
		// error-level violations were fixed in place (they still carry non-failing style warnings). Only truly
		// un-lintable / non-source paths are ignored:
		//   • build output (dist) and monaco's regenerated demo (vendored CodinGame source)
		//   • tsval's vendored differential corpora, generated test reports, and markdown (no tsconfig for typed rules)
		//   • the sign-in pages' Web Awesome bundle (packages/api/scripts/webawesome.ts), build output
		"ignores": ["**/dist/**", "**/demo/**", "packages/tsval/vendor/**", "packages/*/test/reports/**", "**/*.md", "packages/api/public/webawesome.js", "packages/api/public/webawesome.css"]
	},
	{
		// tsval's tests run on `node:test`, not vitest. @antfu's test config assumes vitest and its auto-fix
		// rewrites `node:test`→`vitest` (and `test`→`it`), which breaks them — keep the node:test convention.
		"files": ["**/*.test.*", "**/test/**"],
		"rules": {
			"test/no-import-node-test": "off",
			"test/consistent-test-it": "off",
			// A top-level `test(...)` returns a promise that is MEANT to float: under `node --test
			// --test-isolation=none`, `await`ing it during module evaluation deadlocks the runner (eval blocks on
			// the test, the test can't start until eval finishes). The floating call is the node:test idiom, so
			// no-floating-promises is a false positive on every top-level test in these files.
			"ts/no-floating-promises": "off"
		}
	},
	{
		// The BABLR grammar is a class of parser PRODUCTIONS, not ordinary methods, and two "everything-on"
		// rules are semantically impossible to satisfy on it rather than merely noisy:
		//   • naming-convention — a production's name IS its grammar symbol: `*_Type()` is what `<_Type />` calls
		//     and `*Statement()` what `<Statement />` calls. Renaming them to camelCase would break the grammar.
		//   • class-methods-use-this — productions are dispatched by the BABLR runtime off the class and drive the
		//     parse through the yielded instruction API (eat/match/…); many legitimately never touch `this`. They
		//     cannot be hoisted to free functions without losing that dispatch.
		"files": ["packages/bablr-language-ts/lib/grammar.ts"],
		"rules": {
			"ts/naming-convention": "off",
			"ts/class-methods-use-this": "off"
		}
	}
];
