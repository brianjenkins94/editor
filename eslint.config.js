import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import config from "@brianjenkins94/util/eslint";
import webawesome from "./packages/eslint-plugin-webawesome/src/index.js";

// The Web Awesome components the app may use: what the theme package re-exports (packages/theme/src/components/, its
// curated catalog, packages/theme/README.md, *Only through the theme*), and Web Awesome's whole catalog, so webawesome/known-components tells a component's tag
// from a utility class. (Web Awesome resolved as the editor's code resolves it.)
const THEME_COMPONENTS = readdirSync(new URL("packages/theme/src/components", import.meta.url)).filter((file) => file.endsWith(".js")).map((file) => file.slice(0, -".js".length));
// Web Awesome's installed dist/ — or none where it isn't installed: in the editor, which serves a registry package from
// the CDN as it's used, so none is on disk. There the two rules that read its files (known-components, known-classes)
// are off, and every other rule applies.
const WEB_AWESOME = (() => {
	try {
		return path.dirname(path.dirname(path.dirname(createRequire(new URL("packages/editor/package.json", import.meta.url)).resolve("@awesome.me/webawesome/dist/components/button/button.js"))));
	} catch {
		return undefined;
	}
})();
const WEB_AWESOME_COMPONENTS = WEB_AWESOME === undefined ? [] : readdirSync(path.join(WEB_AWESOME, "components"));

// The class names something styles (packages/theme/README.md, *Class names, a closed set*; webawesome/known-classes): Web Awesome's utilities (and the families it
// matches by prefix, `[class*='wa-stack']`) from its installed CSS, and every class the theme's Stitches styles declare
// (its recipes, its surfaces' styles).
const WEB_AWESOME_STYLES = WEB_AWESOME === undefined ? undefined : path.join(WEB_AWESOME, "styles");
const cssFiles = (folder) => readdirSync(folder, { "recursive": true }).filter((file) => String(file).endsWith(".css")).map((file) => readFileSync(path.join(folder, String(file)), "utf8"));
const classesIn = (text) => [...text.replaceAll(/\/\*[\s\S]*?\*\//gu, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((match) => match[1]);
// And the classes Stitches styles: a selector key in a `css({…})` / `globalCss({…})` object (`"&.open"`).
const sourceFiles = (folder) => readdirSync(folder, { "recursive": true }).filter((file) => /\.tsx?$/u.test(String(file)) && !String(file).includes("node_modules")).map((file) => readFileSync(path.join(folder, String(file)), "utf8"));
const stitchesClasses = (text) => (/\b(?:css|globalCss|unlayeredGlobalCss|stylesheet|recipe)\(\{/u.test(text) ? [...text.matchAll(/"([^"\n]*?[&\s>~+,]?\.[_a-zA-Z][\w-]*[^"\n]*)":\s*\{/gu)].flatMap((match) => classesIn(match[1])) : []);
const KNOWN_CLASSES = WEB_AWESOME_STYLES === undefined ? [] : [...new Set([
	...cssFiles(WEB_AWESOME_STYLES),
	...cssFiles(url.fileURLToPath(new URL("packages/theme/src", import.meta.url)))
].flatMap(classesIn).concat(["packages/editor", "packages/theme/src"].flatMap((folder) => sourceFiles(url.fileURLToPath(new URL(folder, import.meta.url)))).flatMap(stitchesClasses)))];
// The classes no stylesheet of ours declares that are still meant: VS Code's own (its codicons, styled by VS Code), and
// hooks the tours and the code query (each named, so a new one shows in review).
const KNOWN_ELSEWHERE = [
	"^codicon(?:-|$)",
	"^(?:rule-panel-choice|rule-editor|rule-editor-then)$", // the tours drive the rule editor and the Rule view by these
	"^(?:live-values-split|live-values-menu-item|more)$", // the tours read an ask's split buttons by these; pane-native.ts reads `more`
	"^gp-expand$" // git-panel.tsx finds a row's expander by it
];
const WEB_AWESOME_PREFIXES = WEB_AWESOME_STYLES === undefined ? [] : [...new Set(cssFiles(path.join(WEB_AWESOME_STYLES, "utilities")).flatMap((text) => [...text.matchAll(/\[class\*=['"](wa-[a-z-]+)['"]\]/gu)].map((match) => match[1])))];

// The editor's folders are its realms (packages/editor/ARCHITECTURE.md): a realm imports another realm's code only
// through shared/. A relative import that climbs out of its folder and into another realm's is an error. The
// composition roots (main.tsx, build.ts, dev.ts), the tests and the benches may reach anywhere.
const EDITOR = "packages/editor";
const REALMS = ["app", "shell", "workbench", "workers", "previews", "extensions"];
const EXTENSIONS = readdirSync(new URL(EDITOR + "/extensions", import.meta.url), { "withFileTypes": true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const SOURCES = "*.{ts,tsx,mts,js,mjs}";
// An extension imports core's code from editor-api, never shared/ (packages/editor/ARCHITECTURE.md, "Features as extensions") — but the bridge, which is
// core's.
const STILL_IN_SHARED = new Set(["bridge"]);
// And tsval's privilege (packages/editor/ARCHITECTURE.md, *Extension points* 2): almostnode on the workspace's buffer, as core runs it — only these.
const PRIVILEGED = { "tsval": ["workspace-runtime", "zenfs-vfs.js"] };

/** `files` may not climb into any of the `banned` folders — but for `allowed`, shared/ files they may import. */
function realmImports(files, banned, ignores = [], allowed = []) {
	const shared = allowed.length === 0 ? "" : "|shared/(?!(?:" + allowed.map((file) => file.replaceAll(".", "\\.")).join("|") + ")$)";
	const pattern = {
		"regex": "^(?:\\.\\./)+(?:(?:" + banned.join("|") + ")(?:/|$)" + shared + ")",
		"message": "Realms import each other only through shared/, and extensions core's code only through editor-api (packages/editor/ARCHITECTURE.md, \"The realms\" and \"Features as extensions\")."
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
		// theme/styles/workbench is VS Code's baseline: overrides of VS Code's own CSS, on --vscode-* (packages/theme/README.md, *Outside the rules*).
		"ignores": ["packages/editor/demo/**", "packages/theme/src/styles/workbench.ts", "contrib/**"],
		"plugins": { "webawesome": webawesome },
		"rules": {
			"webawesome/prefer-components": "error",
			"webawesome/no-html-in-strings": "error",
			"webawesome/no-css-in-strings": "error",
			"webawesome/no-inline-styles": "error",
			"webawesome/prefer-components-wrapped": "error",
			"webawesome/no-css-imports": "error",
			"webawesome/css-in-js-tokens": "error",
			"webawesome/through-theme": "error",
			...WEB_AWESOME === undefined ? {} : {
				"webawesome/known-components": ["error", { "allowed": THEME_COMPONENTS, "catalog": WEB_AWESOME_COMPONENTS }],
				"webawesome/known-classes": ["error", { "known": KNOWN_CLASSES, "prefixes": WEB_AWESOME_PREFIXES, "allow": KNOWN_ELSEWHERE, "wrappers": { "element": 1 } }]
			}
		}
	},
	{
		// The ways in to Web Awesome that aren't the theme's re-exports: the theme itself; the API's sign-in pages, which
		// bundle Web Awesome themselves (the api doesn't depend on theme: packages/theme/README.md, *Outside the rules*); and this plugin, whose maps name
		// Web Awesome's components as data.
		"files": ["packages/theme/**", "packages/api/scripts/webawesome.ts", "packages/eslint-plugin-webawesome/**"],
		"rules": { "webawesome/through-theme": "off", "webawesome/known-components": "off", "webawesome/known-classes": "off" }
	},
	{
		// Tests write the HTML of the apps and pages they run as fixtures, and compare markup as text.
		"files": ["**/test/**", "**/*.test.{ts,mjs,js}"],
		"rules": { "webawesome/no-html-in-strings": "off" }
	},
	{
		// The theme package is where the stylesheets live: it adopts its own and Web Awesome's.
		"files": ["packages/theme/**"],
		"rules": { "webawesome/no-css-imports": "off" }
	},
	{
		// The CSS half of the guardrails (packages/theme/README.md, *The four lint gaps*), in ESLint's CSS language (util's preset registers
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
		// The theme's tokens (theme/tokens): token definitions, not uses — the brand's literal ramp, and the bridge, the one
		// place --vscode-* is read for a token.
		"files": ["packages/theme/src/tokens.ts"],
		"rules": { "webawesome/css-in-js-tokens": "off" }
	},
	{
		// The API's sign-in pages bundle Web Awesome themselves (the api doesn't depend on theme): their one sheet centres the
		// card (packages/theme/README.md, *Outside the rules*).
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
