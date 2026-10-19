import stylelint from "stylelint";

// The CSS half of the Web Awesome guardrails (eslint.config.js has the code half; packages/theme/PLAN.md has the
// plan). Every .css file outside the theme is custom CSS: these rules hold it to Web Awesome's tokens, keep it off
// Web Awesome's own components and classes, and put it in a cascade layer.

// Every style rule sits inside an `@layer`, so it never silently outranks Web Awesome's layered styles (Web
// Awesome declares its own layer order in layers.css). Bamboo's `no-unlayered-override`, for stylesheets.
const UNLAYERED = "webawesome/no-unlayered-rules";
const noUnlayeredRules = stylelint.createPlugin(UNLAYERED, (enabled) => (root, result) => {
	if (!enabled) {
		return;
	}

	root.walkRules((rule) => {
		let parent = rule.parent;

		while (parent !== undefined && parent.type !== "root") {
			if (parent.type === "atrule" && /^(?:layer|keyframes)$/u.test(parent.name)) {
				return;
			}

			parent = parent.parent;
		}

		stylelint.utils.report({ "ruleName": UNLAYERED, "result": result, "node": rule, "message": "Put \"" + rule.selector + "\" inside an @layer — an unlayered rule outranks every Web Awesome layer. (" + UNLAYERED + ")" });
	});
});

// Values that are never a design decision, so never need a token.
const NEUTRAL_VALUES = ["inherit", "initial", "unset", "revert", "currentColor", "currentcolor", "transparent", "none", "auto", "0", "normal"];

export default {
	"defaultSeverity": "error",
	"plugins": ["stylelint-declaration-strict-value", noUnlayeredRules],
	"ignoreFiles": ["**/node_modules/**", "**/dist/**", "**/demo/**", "docs/**", "contrib/**"],
	"rules": {
		// Colors, spacing, type and shape come from the theme: a Web Awesome token (`var(--wa-*)`), not a literal.
		// Bamboo's `prefer-token` / `no-hardcoded-color`.
		"scale-unlimited/declaration-strict-value": [
			[
				"/color$/",
				"background",
				"fill",
				"stroke",
				"box-shadow",
				"/^(padding|margin|gap|row-gap|column-gap)/",
				"font-size",
				"font-weight",
				"font-family",
				"line-height",
				"border-radius"
			],
			{
				"ignoreValues": NEUTRAL_VALUES,
				"ignoreFunctions": false,
				"expandShorthand": true
			}
		],
		// VS Code's theme variables are mapped onto Web Awesome's tokens in one place (theme/vscode, PLAN.md §3) —
		// nowhere else.
		"declaration-property-value-disallowed-list": [
			{ "/.*/": ["/var\\(--vscode-/"] },
			{ "message": "Use the Web Awesome token, not a --vscode-* variable: theme maps VS Code's theme onto --wa-* in one place." }
		],
		"declaration-no-important": true,
		// Web Awesome's components and classes are styled through its tokens, not by selecting them: no `wa-*` type
		// selectors, no `::part()`, and no `.wa-*` classes of our own (a `wa-` prefix must mean Web Awesome's).
		"selector-disallowed-list": [
			["/(^|[\\s>+~(,])wa-[a-z]/", "/::part\\(/", "/\\.wa-/"],
			{ "message": "Don't select Web Awesome's components, parts or classes — style them through their tokens." }
		],
		[UNLAYERED]: true
	},
	"overrides": [
		{
			// The theme IS the token layer: unlayered on purpose so its overrides win over Web Awesome's layers.
			"files": ["packages/theme/**/*.css"],
			"rules": {
				[UNLAYERED]: null,
				"declaration-property-value-disallowed-list": null
			}
		}
	]
};
