/**
 * Local ESLint plugin — push the shell UI onto Web Awesome components + JSX, and off hand-rolled markup.
 *
 * The product goal is to author the shell with as little of our own HTML/CSS as humanly possible: reach for a
 * `<wa-*>` component whenever one exists, and write markup as JSX in `.tsx` (never as HTML baked into a string). These
 * two rules make the anti-patterns ERRORS so the migration is enforced, not just intended. Scope them (in
 * eslint.config.js) to the shell/UI surface — sample content, grammars, and fixtures legitimately contain angle
 * brackets and must not be caught.
 *
 * Rules:
 *   • prefer-components  — a native HTML element that has a Web Awesome complement (`<button>` → `<wa-button>`, …),
 *     whether written as a JSX element or as `document.createElement("button")`.
 *   • no-html-in-strings — HTML markup embedded in a string or template literal (`innerHTML = "<div>…"`, a `MARKUP`
 *     constant, …). Author it as a JSX component instead.
 *   • no-css-in-strings  — CSS embedded in a string or template literal (a `STYLES` constant, `style.textContent = …`).
 *     Style with the theme tokens + Web Awesome utility classes, not hand-written CSS.
 *   • no-inline-styles   — an inline style: a JSX `style` attribute, an `el.style.… =` assignment, or
 *     `setAttribute("style", …)`. Same reason — a class/token, not inline CSS. (Dynamic geometry that genuinely needs
 *     it, e.g. drag positioning, should be an explicit eslint-disable.)
 *   • prefer-components-wrapped — the same native elements created through a local wrapper around createElement
 *     (`html("button")`, `element("select")`), which prefer-components can't see.
 *   • no-css-imports     — importing a stylesheet other than Web Awesome's or the theme's (`import "./foo.css"`).
 *   • css-in-js-tokens   — a literal colour, font size, spacing length or radius in Stitches' `css({…})` /
 *     `globalCss({…})`, so those values are `--wa-*` tokens too.
 *
 * And for stylesheets, in ESLint's CSS language (@eslint/css, which util's preset registers for **\/*.css):
 *   • css-tokens              — the same token policy as css-in-js-tokens, for a `.css` file's declarations.
 *   • css-no-vscode-variables — a `var(--vscode-*)`: VS Code's theme is read through theme/vscode's mapping only.
 *   • css-no-wa-selectors     — selecting a `wa-*` component, its `::part()`, or a `.wa-*` class of our own.
 *   • css-only-in-theme       — a stylesheet outside the theme package (enabled for the files that aren't in it).
 *
 * And Web Awesome through the theme package (packages/theme/PLAN.md §7.2):
 *   • through-theme    — importing Web Awesome or Stitches itself, not the theme's (theme/components/<name>, theme, …,
 *     theme/stitches).
 *   • known-components — a `wa-*` component the theme doesn't export, in JSX or given to a create call.
 *   • known-classes    — a class name nothing styles or declares: not a Web Awesome utility, nor declared in the
 *     theme's stylesheets.
 * Layers and `!important` are the CSS language's own rules (css/use-layers, css/no-important).
 */

/** Native tag → the Web Awesome component to use instead. Only CLEAR complements (from the WA 3.13 catalog); layout
 *  elements (div/span/main/aside/section) intentionally stay native — WA has no 1:1 complement for them. */
const NATIVE_TO_WA = {
	"button": "wa-button",
	"input": "wa-input",
	"textarea": "wa-textarea",
	"select": "wa-select",
	"option": "wa-option",
	"dialog": "wa-dialog",
	"details": "wa-details",
	"hr": "wa-divider",
	"progress": "wa-progress-bar",
	"meter": "wa-progress-ring"
};

/** `<input type="…">` maps to a more specific component than the generic `wa-input`. */
const INPUT_TYPE_TO_WA = {
	"checkbox": "wa-checkbox",
	"radio": "wa-radio",
	"range": "wa-slider",
	"number": "wa-number-input",
	"color": "wa-color-picker"
};

/** A conservative set of real HTML tag names — used so `no-html-in-strings` fires on genuine markup but not on stray
 *  angle brackets (a `<` comparison, a `List<T>` mention). A hyphenated name (a custom element like `wa-button`) also
 *  qualifies, so markup for the very components we're adopting is caught in strings too. */
const KNOWN_HTML = new Set([
	"a",
	"abbr",
	"address",
	"area",
	"article",
	"aside",
	"audio",
	"b",
	"base",
	"bdi",
	"bdo",
	"blockquote",
	"body",
	"br",
	"button",
	"canvas",
	"caption",
	"cite",
	"code",
	"col",
	"colgroup",
	"data",
	"datalist",
	"dd",
	"del",
	"details",
	"dfn",
	"dialog",
	"div",
	"dl",
	"dt",
	"em",
	"embed",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hgroup",
	"hr",
	"html",
	"i",
	"iframe",
	"img",
	"input",
	"ins",
	"kbd",
	"label",
	"legend",
	"li",
	"link",
	"main",
	"map",
	"mark",
	"menu",
	"meta",
	"meter",
	"nav",
	"object",
	"ol",
	"optgroup",
	"option",
	"output",
	"p",
	"picture",
	"pre",
	"progress",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"script",
	"section",
	"select",
	"slot",
	"small",
	"source",
	"span",
	"strong",
	"style",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"template",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"time",
	"title",
	"tr",
	"track",
	"u",
	"ul",
	"var",
	"video",
	"wbr"
]);

/** Does `text` contain an HTML/custom-element tag? Requires a closing `>` so `a < b` never matches, and the tag name
 *  must be a known HTML element or hyphenated (a custom element) so generics/comparisons in strings don't false-fire. */
function containsMarkup(text) {
	// A whole document (`<!doctype html>…`) is what a webview, an iframe's srcdoc or a served page is given, and only as
	// a string: no component can be it.
	if (/^\s*<!doctype html/iu.test(text)) {
		return false;
	}

	const tag = /<(\/?)([a-z][a-z0-9-]*)\b([^<>]*)>/gu;
	let match = tag.exec(text);

	while (match !== null) {
		const [, closing, name, rest] = match;

		// A tag is markup when it closes, has attributes, closes itself or is closed later; a bare `<name>` is a
		// placeholder (`node <file>`, "<non-string>", `<button#add>`).
		const markup = closing === "/" || /^\s+\S/u.test(rest) || rest.endsWith("/") || text.includes("</" + name, match.index);

		if (markup && (name.includes("-") || KNOWN_HTML.has(name))) {
			return true;
		}

		match = tag.exec(text);
	}

	return false;
}

/** Common CSS property names — the discriminator between CSS and an arbitrary JS object literal (`{ value: true }`,
 *  `{ a: 1 }`). A declaration whose property is one of these (or a `--custom` / `-vendor` prefixed name) is CSS; one
 *  whose property is `value` / `a` / `default` is not. Not exhaustive — enough to recognize real stylesheets/blocks. */
const CSS_PROPS = new Set([
	"align-items",
	"align-self",
	"background",
	"background-color",
	"background-image",
	"background-position",
	"background-size",
	"border",
	"border-bottom",
	"border-color",
	"border-left",
	"border-radius",
	"border-right",
	"border-top",
	"bottom",
	"box-shadow",
	"box-sizing",
	"color",
	"columns",
	"content",
	"cursor",
	"direction",
	"display",
	"fill",
	"flex",
	"flex-direction",
	"flex-wrap",
	"float",
	"font",
	"font-family",
	"font-size",
	"font-weight",
	"gap",
	"grid",
	"grid-area",
	"grid-template",
	"grid-template-columns",
	"grid-template-rows",
	"height",
	"justify-content",
	"left",
	"letter-spacing",
	"line-height",
	"margin",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"object-fit",
	"opacity",
	"outline",
	"overflow",
	"overflow-x",
	"overflow-y",
	"padding",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"place-items",
	"pointer-events",
	"position",
	"right",
	"stroke",
	"text-align",
	"text-decoration",
	"text-overflow",
	"text-transform",
	"top",
	"transform",
	"transition",
	"user-select",
	"visibility",
	"white-space",
	"width",
	"z-index"
]);

/** Does `text` look like CSS? True when it holds two-plus real CSS DECLARATIONS — `prop: value;` (or `prop: value}`)
 *  whose property is a known CSS property or a `--custom` / `-vendor` prefixed name. Requiring known properties keeps
 *  JS object literals (`{ a: 1, b: 2 }`), switch blocks, and type literals in strings from false-firing, while
 *  catching stylesheets, `<style>` blocks, and inline-style-shaped strings. */
function containsCss(text) {
	const declaration = /(-{0,2}[a-z][a-z0-9-]*)\s*:[^;{}]+[;}]/giu;
	let count = 0;
	let match = declaration.exec(text);

	while (match !== null) {
		const property = match[1].toLowerCase();

		if (property.startsWith("-") || CSS_PROPS.has(property)) {
			count += 1;

			if (count >= 2) {
				return true;
			}
		}

		match = declaration.exec(text);
	}

	return false;
}

/** The WA component to suggest for a JSX `<input>`, refined by its `type` attribute when that is a string literal. */
function waForInputJsx(node) {
	const typeAttr = node.attributes.find((attribute) => attribute.type === "JSXAttribute" && attribute.name.name === "type");
	const value = typeAttr?.value;

	if (value !== undefined && value !== null && value.type === "Literal" && typeof value.value === "string") {
		return INPUT_TYPE_TO_WA[value.value] ?? "wa-input";
	}

	return "wa-input";
}

/** A message's data for a native tag and the Web Awesome component to use instead: the component's theme import name
 *  too (theme/components/<name>, the only way in to it: through-theme). */
function suggestion(tag, wa) {
	return { "tag": tag, "wa": wa, "name": wa.replace(/^wa-/u, "") };
}

const preferComponents = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Use a Web Awesome component instead of the native HTML element that has a complement." },
		"messages": {
			"useComponent": "Use <{{wa}}> (import \"theme/components/{{name}}\") instead of the native <{{tag}}> — Web Awesome has a complement. Keep hand-rolled markup to a minimum.",
			"createElement": "Use document.createElement(\"{{wa}}\") (import \"theme/components/{{name}}\") instead of \"{{tag}}\" — Web Awesome has a complement."
		},
		"schema": []
	},
	"create": function(context) {
		return {
			"JSXOpeningElement": function(node) {
				if (node.name.type !== "JSXIdentifier") {
					return; // member expression (<Foo.Bar/>) or namespaced — never a native tag
				}

				const tag = node.name.name;
				const wa = NATIVE_TO_WA[tag];

				if (wa === undefined) {
					return;
				}

				context.report({ "node": node.name, "messageId": "useComponent", "data": suggestion(tag, tag === "input" ? waForInputJsx(node) : wa) });
			},
			"CallExpression": function(node) {
				const callee = node.callee;

				if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier" || callee.property.name !== "createElement") {
					return;
				}

				const arg = node.arguments[0];

				if (arg === undefined || arg.type !== "Literal" || typeof arg.value !== "string") {
					return;
				}

				const wa = NATIVE_TO_WA[arg.value];

				if (wa !== undefined) {
					context.report({ "node": arg, "messageId": "createElement", "data": suggestion(arg.value, wa) });
				}
			}
		};
	}
};

const noHtmlInStrings = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Author markup as JSX in a .tsx component, not as HTML embedded in a string or template literal." },
		"messages": {
			"noHtml": "Author this markup as JSX in a .tsx component, not as HTML in a {{kind}} — this is exactly the hand-rolled markup we're removing."
		},
		"schema": []
	},
	"create": function(context) {
		return {
			"Literal": function(node) {
				if (typeof node.value === "string" && containsMarkup(node.value)) {
					context.report({ "node": node, "messageId": "noHtml", "data": { "kind": "string" } });
				}
			},
			"TemplateLiteral": function(node) {
				const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(" ");

				if (containsMarkup(text)) {
					context.report({ "node": node, "messageId": "noHtml", "data": { "kind": "template string" } });
				}
			}
		};
	}
};

const noCssInStrings = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Style with the theme tokens + Web Awesome utility classes, not CSS embedded in a string or template literal." },
		"messages": {
			"noCss": "Style with the theme tokens + Web Awesome utility classes, not CSS in a {{kind}} — this is exactly the hand-rolled CSS we're removing."
		},
		"schema": []
	},
	"create": function(context) {
		return {
			"Literal": function(node) {
				if (typeof node.value === "string" && containsCss(node.value)) {
					context.report({ "node": node, "messageId": "noCss", "data": { "kind": "string" } });
				}
			},
			"TemplateLiteral": function(node) {
				const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(" ");

				if (containsCss(text)) {
					context.report({ "node": node, "messageId": "noCss", "data": { "kind": "template string" } });
				}
			}
		};
	}
};

/** Is `node` a member-expression assignment target that writes to `.style` (`el.style = …`, `el.style.left = …`,
 *  `el.style.cssText = …`)? */
function isStyleAssignmentTarget(left) {
	if (left.type !== "MemberExpression") {
		return false;
	}

	if (left.property.type === "Identifier" && left.property.name === "style") {
		return true; // el.style = "…"
	}

	return left.object.type === "MemberExpression" && left.object.property.type === "Identifier" && left.object.property.name === "style"; // el.style.<prop> = …
}

const noInlineStyles = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Avoid inline styles — style with theme tokens + Web Awesome utility classes (a class), not inline CSS." },
		"messages": {
			"jsxStyle": "Avoid an inline `style` attribute — style with a Web Awesome utility class / theme token, not inline CSS.",
			"domStyle": "Avoid setting `.style` imperatively — use a Web Awesome utility class / theme token. (Dynamic geometry that genuinely needs it should be an explicit eslint-disable.)",
			"setAttrStyle": "Avoid setAttribute(\"style\", …) — use a Web Awesome utility class / theme token, not inline CSS."
		},
		"schema": []
	},
	"create": function(context) {
		return {
			"JSXAttribute": function(node) {
				if (node.name.type === "JSXIdentifier" && node.name.name === "style") {
					context.report({ "node": node, "messageId": "jsxStyle" });
				}
			},
			"AssignmentExpression": function(node) {
				if (isStyleAssignmentTarget(node.left)) {
					context.report({ "node": node.left, "messageId": "domStyle" });
				}
			},
			"CallExpression": function(node) {
				const callee = node.callee;

				if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") {
					return;
				}

				const arg = node.arguments[0];

				if (callee.property.name === "setAttribute" && arg !== undefined && arg.type === "Literal" && arg.value === "style") {
					context.report({ "node": node, "messageId": "setAttrStyle" });
				}

				// Object.assign(element.style, { … }): setting `.style`, several properties at once.
				if (callee.object.type === "Identifier" && callee.object.name === "Object" && callee.property.name === "assign" && arg?.type === "MemberExpression" && arg.property.type === "Identifier" && arg.property.name === "style") {
					context.report({ "node": node, "messageId": "domStyle" });
				}
			}
		};
	}
};

/** The tag argument of an element-creating call: `createElement(tag)` / `x.createElement(tag)` take it first,
 *  `createElementNS(ns, tag)` second. Undefined for any other call. */
function createElementTag(node) {
	const callee = node.callee;
	let name = callee.type === "Identifier" ? callee.name : undefined;

	if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
		name = callee.property.name;
	}

	if (name === "createElement") {
		return node.arguments[0];
	}

	if (name === "createElementNS") {
		return node.arguments[1];
	}

	return undefined;
}

/** The name a function is called by: its declaration's id, or the variable an arrow/function expression is bound to. */
function functionName(fn) {
	if (fn.id !== null && fn.id !== undefined) {
		return fn.id.name;
	}

	const parent = fn.parent;

	return parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : undefined;
}

/** The nearest function enclosing `node`. */
function enclosingFunction(node) {
	let current = node.parent;

	while (current !== null && current !== undefined && !/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(current.type)) {
		current = current.parent;
	}

	return current;
}

const preferComponentsWrapped = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Use a Web Awesome component instead of a native element created through a local wrapper (`html(\"button\")`, `element(\"select\")`)." },
		"messages": {
			"wrapped": "{{wrapper}}(\"{{tag}}\") creates a native <{{tag}}> — use \"{{wa}}\" (import \"theme/components/{{name}}\"). Web Awesome has a complement; a wrapper around createElement doesn't change that."
		},
		"schema": []
	},
	"create": function(context) {
		// A wrapper is a function in this file that passes one of its own parameters to createElement as the tag. Calls
		// are collected as the file is walked and judged at the end, once every wrapper in the file is known (a wrapper
		// may be declared below its first use). Imported wrappers aren't resolved; none exist today.
		const wrappers = new Map();
		const calls = [];

		return {
			"CallExpression": function(node) {
				const tag = createElementTag(node);

				if (tag?.type === "Identifier") {
					const fn = enclosingFunction(node);
					const index = fn === null || fn === undefined ? -1 : fn.params.findIndex((param) => param.type === "Identifier" && param.name === tag.name);
					const name = index === -1 ? undefined : functionName(fn);

					if (name !== undefined) {
						wrappers.set(name, index);
					}
				}

				if (node.callee.type === "Identifier") {
					calls.push(node);
				}
			},
			"Program:exit": function() {
				for (const node of calls) {
					const index = wrappers.get(node.callee.name);
					const arg = index === undefined ? undefined : node.arguments[index];
					const wa = arg?.type === "Literal" && typeof arg.value === "string" ? NATIVE_TO_WA[arg.value] : undefined;

					if (wa !== undefined) {
						context.report({ "node": arg, "messageId": "wrapped", "data": { "wrapper": node.callee.name, ...suggestion(arg.value, wa) } });
					}
				}
			}
		};
	}
};

/** Is `source` a stylesheet import (`./x.css`, `x.css?inline`)? */
function isCssSource(source) {
	return /\.css(?:\?.*)?$/u.test(source);
}

const noCssImports = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Import stylesheets only from the theme and Web Awesome — a feature's own .css file is the custom CSS we're removing." },
		"messages": {
			"cssImport": "Don't import \"{{source}}\" — style with Web Awesome components, utility classes and the theme's tokens. Stylesheets come only from {{allowed}}."
		},
		"schema": [{
			"type": "object",
			"properties": { "allow": { "type": "array", "items": { "type": "string" } } },
			"additionalProperties": false
		}]
	},
	"create": function(context) {
		// Package prefixes whose stylesheets may be imported: Web Awesome's own, and the theme package.
		const allow = context.options[0]?.allow ?? ["@awesome.me/webawesome", "theme"];
		const allowed = (source) => allow.some((prefix) => source === prefix || source.startsWith(prefix + "/"));

		function check(node, sourceNode) {
			if (sourceNode?.type === "Literal" && typeof sourceNode.value === "string" && isCssSource(sourceNode.value) && !allowed(sourceNode.value)) {
				context.report({ "node": node, "messageId": "cssImport", "data": { "source": sourceNode.value, "allowed": allow.join(" and ") } });
			}
		}

		return {
			"ImportDeclaration": (node) => check(node, node.source),
			"ImportExpression": (node) => check(node, node.source)
		};
	}
};

/** Web Awesome's font-size steps, by their size at the default scale (themes/default.css). */
const FONT_SIZE_TOKENS = { "10": "3xs", "11": "2xs", "12": "xs", "14": "s", "16": "m", "20": "l", "25": "xl", "32": "2xl", "41": "3xl", "52": "4xl", "66": "5xl" };

/** Web Awesome's space steps, by their size at the default scale. */
const SPACE_TOKENS = { "2": "3xs", "4": "2xs", "8": "xs", "12": "s", "16": "m", "24": "l", "32": "xl", "40": "2xl", "48": "3xl", "64": "4xl", "80": "5xl" };

/** Web Awesome's radius steps, by their size at the default scale. */
const RADIUS_TOKENS = { "3": "s", "6": "m", "12": "l" };

/** CSS named colours worth catching (a value that is exactly one of them). `transparent`, `currentColor` and `inherit`
 *  aren't colours to tokenize, so they aren't here. */
const NAMED_COLORS = new Set(["black", "white", "red", "green", "blue", "yellow", "orange", "purple", "pink", "gray", "grey", "silver", "maroon", "navy", "teal", "olive", "lime", "aqua", "fuchsia", "cyan", "magenta", "brown", "gold", "indigo", "violet", "crimson", "coral", "salmon", "tomato"]);

/** A literal colour in a CSS value: a hex colour or a colour function. */
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu;

/** A literal length in a CSS value (`12px`, `0.5rem`), not one inside a custom property's name. */
const LITERAL_LENGTH = /(?<![\w-])(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em)\b/giu;

/** `fontSize` → `font-size`; a key already in kebab case (or a `--custom` property) stays as it is. */
function cssProperty(key) {
	return key.startsWith("--") ? key : key.replace(/[A-Z]/gu, (letter) => "-" + letter.toLowerCase());
}

/** The token to name for a literal `px` size, from a size → step table: the exact step, or the nearest one. */
function nearestStep(px, steps) {
	const sizes = Object.keys(steps).map(Number);
	const nearest = sizes.reduce((best, size) => (Math.abs(size - px) < Math.abs(best - px) ? size : best), sizes[0]);

	return { "step": steps[String(nearest)], "exact": nearest === px };
}

/** Is `property` a spacing property (padding, margin, gap), whose lengths are `--wa-space-*` steps? Layout geometry
 *  (width, height, top, inset, …) has no token, so it isn't one. */
function isSpacing(property) {
	return /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/u.test(property);
}

/** The token messages: a value's literal colour, font size, spacing or radius, said with the step to use. One
 *  policy for both of the places CSS is written — a stylesheet (`css-tokens`) and Stitches' `css({…})`
 *  (`css-in-js-tokens`). */
const TOKEN_MESSAGES = {
	"color": "`{{value}}` is a literal colour in {{property}} — use a --wa-color-* token (surface-*, text-*, <variant>-fill-*/-border-*/-on-*, or a palette hue like --wa-color-orange-60), which follows the theme and its light/dark mode.",
	"colorFallback": "`{{value}}` has a literal colour as a var() fallback in {{property}} — drop it: the --wa-* token is always defined where the theme is loaded.",
	"fontSize": "`{{value}}` is a literal font size — use var(--wa-font-size-{{step}}){{nearest}}.",
	"space": "`{{value}}` is a literal length in {{property}} — use var(--wa-space-{{step}}){{nearest}}.",
	"radius": "`{{value}}` is a literal radius — use var(--wa-border-radius-{{step}}){{nearest}}."
};

/** What's wrong with `text` as `property`'s value, by the token policy: each a message id and its data. */
function tokenProblems(property, text) {
	const problems = [];
	const lengths = (steps, messageId) => {
		for (const match of [...text.matchAll(LITERAL_LENGTH)].filter((length) => Number(length[1]) !== 0)) {
			const amount = Number(match[1]);
			const px = Math.abs(match[2] === "px" ? amount : amount * 16);
			const { step, exact } = nearestStep(px, steps);

			problems.push({ "messageId": messageId, "data": { "value": match[0], "property": property, "step": step, "nearest": exact ? "" : " (the nearest step)" } });
		}
	};

	if (LITERAL_COLOR.test(text) || NAMED_COLORS.has(text.trim().toLowerCase())) {
		problems.push({ "messageId": /var\([^,)]*,[^)]*(?:#|\()/u.test(text) ? "colorFallback" : "color", "data": { "value": text, "property": property } });
	}

	if (property === "font-size" || property === "font") {
		lengths(FONT_SIZE_TOKENS, "fontSize");
	} else if (isSpacing(property)) {
		lengths(SPACE_TOKENS, "space");
	} else if (/^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/u.test(property)) {
		lengths(RADIUS_TOKENS, "radius");
	}

	return problems;
}

const cssInJsTokens = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Write CSS-in-JS (Stitches' `css({…})` / `globalCss({…})`) on Web Awesome's --wa-* tokens, not literal colours, font sizes, spacing or radii, which don't follow the theme." },
		"messages": TOKEN_MESSAGES,
		"schema": [{
			"type": "object",
			"properties": { "sources": { "type": "array", "items": { "type": "string" } }, "recipes": { "type": "array", "items": { "type": "string" } } },
			"additionalProperties": false
		}]
	},
	"create": function(context) {
		// The modules whose `css` / `globalCss` / `keyframes` / `recipe` are Stitches': the theme's one instance by default
		// (`theme/stitches` from outside, `./stitches` inside the theme); and the modules of recipes, whose calls' `css` is
		// a use-site override (PLAN.md §8.2), held to the tokens the same way.
		const sources = (context.options[0]?.sources ?? ["^theme/stitches$", "^\\./stitches(?:\\.ts)?$"]).map((source) => new RegExp(source, "u"));
		const recipeSources = (context.options[0]?.recipes ?? ["^theme/recipes$", "^\\./recipes(?:\\.ts)?$"]).map((source) => new RegExp(source, "u"));
		const stitches = new Set();
		const recipes = new Set();

		function checkValue(property, node) {
			let text;

			if (node.type === "Literal" && typeof node.value === "number") {
				// Stitches writes a bare number as pixels (fontSize: 13 → 13px), except where CSS takes a bare number.
				text = node.value + "px";
			} else if (node.type === "Literal" && typeof node.value === "string") {
				text = node.value;
			} else if (node.type === "TemplateLiteral") {
				text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(" ");
			} else {
				return;
			}

			for (const problem of tokenProblems(property, text)) {
				context.report({ "node": node, ...problem });
			}
		}

		function checkStyles(object) {
			for (const entry of object.properties.filter((property) => property.type === "Property")) {
				let key;

				if (entry.key.type === "Identifier" && !entry.computed) {
					key = entry.key.name;
				} else if (entry.key.type === "Literal" && typeof entry.key.value === "string") {
					key = entry.key.value;
				}

				if (entry.value.type === "ObjectExpression") {
					checkStyles(entry.value); // a nested selector (`&:hover`), an at-rule, or a globalCss selector
				} else if (key !== undefined) {
					checkValue(cssProperty(key), entry.value);
				}
			}
		}

		return {
			"ImportDeclaration": function(node) {
				if (typeof node.source.value !== "string" || ![...sources, ...recipeSources].some((source) => source.test(node.source.value))) {
					return;
				}

				for (const specifier of node.specifiers) {
					if (specifier.type === "ImportSpecifier" && sources.some((source) => source.test(node.source.value)) && ["css", "globalCss", "unlayeredGlobalCss", "keyframes", "recipe", "stylesheet"].includes(specifier.imported.name)) {
						stitches.add(specifier.local.name);
					}

					if (specifier.type === "ImportSpecifier" && recipeSources.some((source) => source.test(node.source.value))) {
						recipes.add(specifier.local.name);
					}
				}
			},
			"CallExpression": function(node) {
				if (node.callee.type === "Identifier" && stitches.has(node.callee.name)) {
					for (const argument of node.arguments) {
						if (argument.type === "ObjectExpression") {
							checkStyles(argument);
						}
					}
				}

				// A recipe's call: its `css`, if any, is a use-site override.
				if (node.callee.type === "Identifier" && recipes.has(node.callee.name) && node.arguments[0]?.type === "ObjectExpression") {
					const override = node.arguments[0].properties.find((property) => property.type === "Property" && (property.key.name ?? property.key.value) === "css");

					if (override?.value.type === "ObjectExpression") {
						checkStyles(override.value);
					}
				}
			}
		};
	}
};

// --- Stylesheets: rules for ESLint's CSS language (@eslint/css, which util's preset registers for **/*.css). The
//     layer and !important rules are the language's own (css/use-layers, css/no-important). ---

const cssTokens = {
	"meta": {
		"type": "problem",
		"languages": ["css/css"],
		"docs": { "description": "Write a stylesheet on Web Awesome's --wa-* tokens, not literal colours, font sizes, spacing or radii, which don't follow the theme — the policy css-in-js-tokens holds Stitches to." },
		"messages": TOKEN_MESSAGES,
		"schema": []
	},
	"create": function(context) {
		return {
			"Declaration": function(node) {
				const property = node.property.toLowerCase();

				for (const problem of tokenProblems(property, context.sourceCode.getText(node.value))) {
					context.report({ "node": node, ...problem });
				}
			}
		};
	}
};

const cssNoVscodeVariables = {
	"meta": {
		"type": "problem",
		"languages": ["css/css"],
		"docs": { "description": "Read VS Code's theme through Web Awesome's tokens: theme/vscode maps it onto --wa-* in one place (packages/theme/src/vscode.css), the only place a --vscode-* variable may appear." },
		"messages": { "vscode": "`{{name}}` is a VS Code theme variable — use the Web Awesome token theme/vscode maps it to (packages/theme/src/vscode.css), or add the mapping there." },
		"schema": []
	},
	"create": function(context) {
		return {
			"Function": function(node) {
				const name = node.name.toLowerCase() === "var" ? node.children[0] : undefined;

				if (name?.type === "Identifier" && name.name.startsWith("--vscode-")) {
					context.report({ "node": node, "messageId": "vscode", "data": { "name": name.name } });
				}
			}
		};
	}
};

const cssNoWebAwesomeSelectors = {
	"meta": {
		"type": "problem",
		"languages": ["css/css"],
		"docs": { "description": "Style Web Awesome's components through their tokens, not by selecting them: no `wa-*` type selectors, no `::part()`, and no `.wa-*` classes of our own (a wa- prefix must mean Web Awesome's)." },
		"messages": {
			"tag": "`{{name}}` selects a Web Awesome component — set its tokens (custom properties) on it or an ancestor instead.",
			"part": "`::part()` reaches into a Web Awesome component — style it through its tokens.",
			"class": "`.{{name}}` is a Web Awesome class name — use Web Awesome's utility as it is, or give ours a name of its own."
		},
		"schema": []
	},
	"create": function(context) {
		return {
			"TypeSelector": function(node) {
				if (node.name.toLowerCase().startsWith("wa-")) {
					context.report({ "node": node, "messageId": "tag", "data": { "name": node.name } });
				}
			},
			"PseudoElementSelector": function(node) {
				if (node.name.toLowerCase() === "part") {
					context.report({ "node": node, "messageId": "part" });
				}
			},
			"ClassSelector": function(node) {
				if (node.name.startsWith("wa-")) {
					context.report({ "node": node, "messageId": "class", "data": { "name": node.name } });
				}
			}
		};
	}
};

const cssOnlyInTheme = {
	"meta": {
		"type": "problem",
		"languages": ["css/css"],
		"docs": { "description": "Keep stylesheets in the theme package (packages/theme/PLAN.md §7): a surface's custom CSS is a named exception in theme/exceptions/, and other packages import what the theme exports." },
		"messages": { "outside": "A stylesheet outside the theme package — put it in packages/theme/src/exceptions/ (a named exception) and import it from theme/exceptions/." },
		"schema": []
	},
	"create": function(context) {
		return {
			"StyleSheet": function(node) {
				context.report({ "node": node, "loc": { "line": 1, "column": 0 }, "messageId": "outside" });
			}
		};
	}
};

// --- Web Awesome through the theme package (packages/theme/PLAN.md §7.2): it re-exports the components the app may
//     use (theme/components/<name>) and the styles (theme, theme/chrome, theme/vscode). ---

/** The theme package's way in to `source`, a Web Awesome or Stitches module. */
function throughThemeFor(source) {
	if (source.startsWith("@stitches/") || source === "theme/stitches") {
		return "a style the theme makes with it: theme/styles/<surface>, or a recipe (theme/recipes) — styles are made in the theme (PLAN.md §8)";
	}

	const component = /\/dist\/components\/([a-z-]+)\//u.exec(source);

	return component === null ? "theme, theme/chrome or theme/vscode (for its styles)" : `theme/components/${component[1]}`;
}

const throughTheme = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Reach Web Awesome and Stitches only through the theme package, which re-exports what the app may use: theme/components/<name> for a component, theme / theme/chrome / theme/vscode for Web Awesome's styles, and the styles it makes with Stitches (theme/styles/*, theme/recipes); theme/stitches itself is the theme's own." },
		"messages": { "direct": "`{{source}}` is reached only through the theme package — import {{instead}} instead (packages/theme/PLAN.md §7.2, §8)." },
		"schema": []
	},
	"create": function(context) {
		function check(node, source) {
			if (source?.type === "Literal" && typeof source.value === "string" && /^(?:@awesome\.me\/webawesome|@stitches\/[a-z-]+|theme\/stitches$)(?:\/|$)/u.test(source.value)) {
				context.report({ "node": source, "messageId": "direct", "data": { "source": source.value, "instead": throughThemeFor(source.value) } });
			}
		}

		return {
			"ImportDeclaration": (node) => check(node, node.source),
			"ImportExpression": (node) => check(node, node.source),
			"ExportNamedDeclaration": (node) => check(node, node.source),
			"ExportAllDeclaration": (node) => check(node, node.source)
		};
	}
};

const knownComponents = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Use only the Web Awesome components the theme package exports (its curated catalog): a `wa-*` component in JSX or given to a create call (createElement, or a wrapper's) must be one of them. Custom elements are global, so an import rule alone can't stop a tag from being used." },
		"messages": { "unknown": "`{{tag}}` isn't one of the Web Awesome components the theme exports — use one that is, or add packages/theme/src/components/{{name}}.js (and .d.ts) to allow it." },
		"schema": [{
			"type": "object",
			"properties": {
				"allowed": { "type": "array", "items": { "type": "string" } },
				"catalog": { "type": "array", "items": { "type": "string" } }
			},
			"required": ["allowed", "catalog"],
			"additionalProperties": false
		}]
	},
	"create": function(context) {
		// `allowed`: the components the theme exports; `catalog`: every Web Awesome component (so a utility class like
		// `wa-dark` given to classList.add isn't mistaken for one). Both by name, without `wa-`.
		const allowed = new Set(context.options[0].allowed);
		const catalog = new Set(context.options[0].catalog);

		function check(node, tag) {
			const name = tag.slice("wa-".length);

			if (tag.startsWith("wa-") && catalog.has(name) && !allowed.has(name)) {
				context.report({ "node": node, "messageId": "unknown", "data": { "tag": tag, "name": name } });
			}
		}

		return {
			"JSXOpeningElement": function(node) {
				if (node.name.type === "JSXIdentifier") {
					check(node.name, node.name.name);
				}
			},
			"CallExpression": function(node) {
				const [first] = node.arguments;

				if (first?.type === "Literal" && typeof first.value === "string") {
					check(first, first.value);
				}
			}
		};
	}
};

// --- Class names: a closed set (packages/theme/PLAN.md §7.4) — Web Awesome's utilities and the classes the theme's
//     stylesheets declare. ---

/** The words of a class string (a template literal's static text only, without the words an expression touches). */
function classWords(node) {
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value.split(/\s+/u).filter(Boolean);
	}

	if (node.type === "TemplateLiteral") {
		return node.quasis.flatMap((quasi, index) => {
			const text = quasi.value.cooked ?? quasi.value.raw;
			const words = text.split(/\s+/u);

			// (a word against `${…}` is only part of a class: `tone-${tone}`)
			return words.filter((word, at) => word !== "" && !(at === 0 && index > 0 && !/^\s/u.test(text)) && !(at === words.length - 1 && index < node.expressions.length && !/\s$/u.test(text)));
		});
	}

	return [];
}

const knownClasses = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Use only class names something styles or declares: a Web Awesome utility, or a class the theme package's stylesheets declare (its recipes, a surface's exception sheet). A bespoke class needs its sheet in the theme, which shows in review." },
		"messages": { "unknown": "`{{name}}` is no Web Awesome utility and no class the theme's stylesheets declare — use a utility or a recipe (app-*), or declare it in the surface's sheet in packages/theme/src/exceptions/." },
		"schema": [{
			"type": "object",
			"properties": {
				"known": { "type": "array", "items": { "type": "string" } },
				"prefixes": { "type": "array", "items": { "type": "string" } },
				"allow": { "type": "array", "items": { "type": "string" } },
				"wrappers": { "type": "object", "additionalProperties": { "type": "integer" } }
			},
			"additionalProperties": false
		}]
	},
	"create": function(context) {
		// `known`: every class name a stylesheet declares; `prefixes`: Web Awesome's families it matches by prefix
		// (`[class*='wa-stack']`); `allow`: patterns for classes styled by someone else's CSS (VS Code's, a library's) or used
		// only as hooks; `wrappers`: local helpers taking a class string, by name → its argument's index.
		const options = context.options[0] ?? {};
		const known = new Set(options.known ?? []);
		const prefixes = options.prefixes ?? [];
		const allow = (options.allow ?? []).map((pattern) => new RegExp(pattern, "u"));
		const wrappers = options.wrappers ?? {};

		function check(node) {
			for (const name of classWords(node)) {
				if (!known.has(name) && !prefixes.some((prefix) => name.startsWith(prefix)) && !allow.some((pattern) => pattern.test(name))) {
					context.report({ "node": node, "messageId": "unknown", "data": { "name": name } });
				}
			}
		}

		const isClassKey = (key) => (key.type === "Identifier" && ["class", "className"].includes(key.name)) || (key.type === "Literal" && ["class", "className"].includes(key.value));

		return {
			"JSXAttribute": function(node) {
				if (node.name.type === "JSXIdentifier" && ["class", "className"].includes(node.name.name) && node.value !== null) {
					check(node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value);
				}
			},
			// (an object's `class` / `className` only where the object goes straight to a call — `Object.assign(el, {…})`,
			// `html(tag, {…})` — not in data, where the key can mean something else: a Durable Object's class)
			"Property": function(node) {
				if (!node.computed && isClassKey(node.key) && node.parent.type === "ObjectExpression" && node.parent.parent.type === "CallExpression" && node.parent.parent.arguments.includes(node.parent)) {
					check(node.value);
				}
			},
			"AssignmentExpression": function(node) {
				if (node.left.type === "MemberExpression" && !node.left.computed && node.left.property.name === "className") {
					check(node.right);
				}
			},
			"CallExpression": function(node) {
				const callee = node.callee;

				if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "MemberExpression" && callee.object.property.name === "classList" && ["add", "remove", "toggle", "contains", "replace"].includes(callee.property.name)) {
					for (const argument of callee.property.name === "toggle" ? node.arguments.slice(0, 1) : node.arguments) {
						check(argument);
					}
				} else if (callee.type === "MemberExpression" && !callee.computed && callee.property.name === "setAttribute" && node.arguments[0]?.type === "Literal" && node.arguments[0].value === "class" && node.arguments[1] !== undefined) {
					check(node.arguments[1]);
				} else if (callee.type === "Identifier" && Object.hasOwn(wrappers, callee.name) && node.arguments[wrappers[callee.name]] !== undefined) {
					check(node.arguments[wrappers[callee.name]]);
				}
			}
		};
	}
};

export default {
	"meta": { "name": "eslint-plugin-webawesome", "version": "0.0.0" },
	"rules": {
		"prefer-components": preferComponents,
		"prefer-components-wrapped": preferComponentsWrapped,
		"no-html-in-strings": noHtmlInStrings,
		"no-css-in-strings": noCssInStrings,
		"no-inline-styles": noInlineStyles,
		"no-css-imports": noCssImports,
		"css-in-js-tokens": cssInJsTokens,
		"css-tokens": cssTokens,
		"css-no-vscode-variables": cssNoVscodeVariables,
		"css-no-wa-selectors": cssNoWebAwesomeSelectors,
		"css-only-in-theme": cssOnlyInTheme,
		"through-theme": throughTheme,
		"known-components": knownComponents,
		"known-classes": knownClasses
	}
};
