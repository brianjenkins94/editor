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
	const tag = /<\/?([a-z][a-z0-9-]*)\b[^<>]*>/gu;
	let match = tag.exec(text);

	while (match !== null) {
		const name = match[1];

		if (name.includes("-") || KNOWN_HTML.has(name)) {
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

const preferComponents = {
	"meta": {
		"type": "problem",
		"docs": { "description": "Use a Web Awesome component instead of the native HTML element that has a complement." },
		"messages": {
			"useComponent": "Use <{{wa}}> instead of the native <{{tag}}> — Web Awesome has a complement. Keep hand-rolled markup to a minimum.",
			"createElement": "Use document.createElement(\"{{wa}}\") instead of \"{{tag}}\" — Web Awesome has a complement."
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

				context.report({ "node": node.name, "messageId": "useComponent", "data": { "tag": tag, "wa": tag === "input" ? waForInputJsx(node) : wa } });
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
					context.report({ "node": arg, "messageId": "createElement", "data": { "tag": arg.value, "wa": wa } });
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

				if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier" || callee.property.name !== "setAttribute") {
					return;
				}

				const arg = node.arguments[0];

				if (arg !== undefined && arg.type === "Literal" && arg.value === "style") {
					context.report({ "node": node, "messageId": "setAttrStyle" });
				}
			}
		};
	}
};

export default {
	"meta": { "name": "eslint-plugin-webawesome", "version": "0.0.0" },
	"rules": {
		"prefer-components": preferComponents,
		"no-html-in-strings": noHtmlInStrings,
		"no-css-in-strings": noCssInStrings,
		"no-inline-styles": noInlineStyles
	}
};
