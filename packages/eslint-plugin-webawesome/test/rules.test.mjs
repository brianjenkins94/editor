/**
 * Each rule catches what it's for, and leaves what the app should write instead: run over a line of each by ESLint itself,
 * as eslint.config.js runs it.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import plugin from "../src/index.js";

// (ESLint, and its CSS language, where util's preset, which eslint.config.js extends, has them)
const fromPreset = createRequire(createRequire(import.meta.url).resolve("@brianjenkins94/util/eslint"));
const { Linter } = fromPreset("eslint");
const css = fromPreset("@eslint/css").default;
const linter = new Linter();

/** What `rule` says of `code`: its messages' ids. */
function said(rule, code, options = [], language = "js") {
	const config = language === "css"
		? { "files": ["**/*.css"], "plugins": { "webawesome": plugin, "css": css }, "language": "css/css", "rules": { [`webawesome/${rule}`]: ["error", ...options] } }
		: { "files": ["**/*.jsx"], "plugins": { "webawesome": plugin }, "languageOptions": { "parserOptions": { "ecmaFeatures": { "jsx": true } } }, "rules": { [`webawesome/${rule}`]: ["error", ...options] } };
	const messages = linter.verify(code, [config], { "filename": `sample.${language === "css" ? "css" : "jsx"}` });

	assert.deepEqual(messages.filter(({ fatal }) => fatal), [], code);

	return messages.map(({ messageId }) => messageId);
}

const RULES = {
	"prefer-components": { "bad": ["const a = <button>Go</button>;", "document.createElement(\"input\");"], "good": ["const a = <wa-button>Go</wa-button>;", "const a = <div />;", "document.createElement(\"div\");"] },
	"prefer-components-wrapped": { "bad": ["function html(tag) { return document.createElement(tag); } html(\"button\");"], "good": ["function html(tag) { return document.createElement(tag); } html(\"section\");"] },
	"no-html-in-strings": { "bad": ["const markup = \"<div class='a'>hello</div>\";", "element.innerHTML = `<p>hello</p>`;"], "good": ["const a = <div>hello</div>;", "const compare = \"a < b\";"] },
	// (in pieces, so this isn't caught itself)
	"no-css-in-strings": { "bad": [["style.textContent = \".a {", "color:", "red;", "margin:", "0; }\";"].join(" ")], "good": ["const name = \"wa-stack\";"] },
	"no-inline-styles": { "bad": ["const a = <div style=\"color: red\" />;", "element.style.color = \"red\";", "element.setAttribute(\"style\", \"color: red\");"], "good": ["const a = <div class=\"wa-stack\" />;"] },
	"no-css-imports": { "bad": ["import \"./shell.css\";"], "good": ["import \"theme\";"] },
	"css-in-js-tokens": { "bad": ["import { css } from \"theme/stitches\"; css({ \"color\": \"#ff0000\" });", "import { css } from \"theme/stitches\"; css({ \"&:hover\": { \"fontSize\": \"13px\" } });"], "good": ["import { css } from \"theme/stitches\"; css({ \"color\": \"var(--wa-color-text-normal)\" });", "css({ \"color\": \"#ff0000\" });"] },
	"through-theme": { "bad": ["import \"@awesome.me/webawesome/dist/components/button/button.js\";", "import { createStitches } from \"@stitches/core\";"], "good": ["import \"theme/components/button\";"] },
	"known-components": { "options": [{ "allowed": ["button"], "catalog": ["button", "carousel"] }], "bad": ["const a = <wa-carousel />;"], "good": ["const a = <wa-button />;", "const a = <app-window />;"] },
	"known-classes": { "options": [{ "known": ["gp-file"], "prefixes": ["wa-"], "allow": [], "wrappers": {} }], "bad": ["const a = <div class=\"mystery\" />;", "element.classList.add(\"mystery\");"], "good": ["const a = <div class=\"gp-file\" />;"] },
	"css-tokens": { "language": "css", "bad": [".a { color: #ff0000; }"], "good": [".a { color: var(--wa-color-text-normal); }"] },
	"css-no-vscode-variables": { "language": "css", "bad": [".a { color: var(--vscode-editor-foreground); }"], "good": [".a { color: var(--wa-color-text-normal); }"] },
	"css-no-wa-selectors": { "language": "css", "bad": ["wa-button { margin: 0; }", ".a::part(base) { margin: 0; }", ".wa-stack { margin: 0; }"], "good": [".gp-file { margin: 0; }"] },
	"css-only-in-theme": { "language": "css", "bad": [".a { margin: 0; }"], "good": [] }
};

test("every rule the plugin has is here", () => {
	assert.deepEqual(Object.keys(RULES).toSorted(), Object.keys(plugin.rules).toSorted());
});

for (const [rule, { bad, good, options, language }] of Object.entries(RULES)) {
	test(`${rule}: caught, and what to write instead left`, () => {
		for (const code of bad) {
			assert.ok(said(rule, code, options, language).length > 0, `not caught: ${code}`);
		}

		for (const code of good) {
			assert.deepEqual(said(rule, code, options, language), [], `caught: ${code}`);
		}
	});
}
