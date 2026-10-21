/**
 * What the components (components/*) need from Web Awesome, derived from Web Awesome itself (PLAN.md §10), so they work
 * without it:
 *
 * - src/web-awesome.ts: its layer order (theme/sheet declares it, rather than importing Web Awesome's layers.css); the
 *   default of every `--wa-*` token a component reads, its `var()`s resolved (theme/stitches' `recipe` puts it in as
 *   the fallback); and each Web Awesome element's native counterpart (theme/component's `webAwesomeOr`), the reverse of
 *   eslint-plugin-webawesome's `prefer-components` map.
 * - components/<name>/custom-elements.json, for a component that defines an element: its `definition` (attributes,
 *   slots, events), the tokens it reads (with Web Awesome's defaults) and the Web Awesome elements it makes, with what
 *   those need in turn.
 *
 *     node packages/theme/scripts/web-awesome.mjs            # write them
 *     node packages/theme/scripts/web-awesome.mjs --check    # fail if they're stale (packages/theme/test/web-awesome.mjs)
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import ts from "typescript";

import { NATIVE_TO_WA } from "../../eslint-plugin-webawesome/src/index.js";

const root = url.fileURLToPath(new URL("../../../", import.meta.url));
const dist = path.dirname(path.dirname(path.dirname(createRequire(path.join(root, "packages/theme/package.json")).resolve("@awesome.me/webawesome/dist/components/button/button.js"))));
const styles = path.join(dist, "styles");
const read = (file) => fs.readFileSync(file, "utf8");

/** The components, and the theme's sources each publishes (its entry re-exports them, by relative path). */
const components = fs.readdirSync(path.join(root, "components")).filter((name) => fs.existsSync(path.join(root, "components", name, "src", name + ".ts")));
const sourceOf = (name) => {
	const entry = path.join(root, "components", name, "src", name + ".ts");

	return [...read(entry).matchAll(/from "(\.\.?\/[^"]+)"/gu)].map((match) => read(path.resolve(path.dirname(entry), match[1]) + ".ts")).join("\n");
};
const sources = Object.fromEntries(components.map((name) => [name, sourceOf(name)]));

// --- Web Awesome's tokens at the root, light: its palette, its colour variants (each default), then its theme.
const blocks = (css) => [...css.replaceAll(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]*)\{([^{}]*)\}/gu)];
const defaults = new Map();

for (const file of ["color/palettes/base.css", "color/palettes/default.css", ...fs.readdirSync(path.join(styles, "color/variants")).sort().map((name) => "color/variants/" + name), "themes/default.css"]) {
	for (const [, selectors, body] of blocks(read(path.join(styles, file)))) {
		if (selectors.split(",").some((selector) => [":root", ":where(:root)"].includes(selector.trim()))) {
			for (const [, name, value] of body.matchAll(/(--wa-[\w-]+):([^;]+);/gu)) {
				defaults.set(name, value.trim().replaceAll(/\s+/gu, " "));
			}
		}
	}
}

/** `value` with every `var(--wa-…)` in it replaced by that token's own default, resolved too. */
function resolve(value, seen = new Set()) {
	return value.replaceAll(/var\((--wa-[\w-]+)\)/gu, (whole, name) => (defaults.has(name) && !seen.has(name) ? resolve(defaults.get(name), new Set([...seen, name])) : whole));
}

/** The `--wa-*` tokens a source reads with no fallback of its own. */
const tokensIn = (text) => [...new Set([...text.matchAll(/var\((--wa-[\w-]+)\)/gu)].map((match) => match[1]))].sort();
const used = new Set(Object.values(sources).flatMap(tokensIn));
const tokens = Object.fromEntries([...used].sort().filter((name) => defaults.has(name)).map((name) => [name, resolve(defaults.get(name))]));

const layers = read(path.join(styles, "layers.css")).match(/@layer [^;{]+;/u)[0];
const natives = Object.fromEntries(Object.entries(NATIVE_TO_WA).map(([native, tag]) => [tag, native]).sort(([left], [right]) => (left < right ? -1 : 1)));

const generated = `/**
 * What the components need from Web Awesome, derived from Web Awesome (scripts/web-awesome.mjs: generated, don't edit):
 * its layer order, the default of each token a component reads, and each element's native counterpart.
 */
export const layers = ${JSON.stringify(layers)};

export const tokens: Readonly<Record<string, string>> = ${JSON.stringify(tokens, undefined, "\t")};

export const natives = ${JSON.stringify(natives, undefined, "\t")} as const;
`;

// --- Each element's custom-elements.json.
const manifest = JSON.parse(read(path.join(dist, "custom-elements.json")));
const elements = new Map(manifest.modules.flatMap((module) => module.declarations ?? []).filter((declaration) => declaration.tagName !== undefined).map((declaration) => [declaration.tagName, declaration]));

/** The object literal `export const definition = {…}` in a source, as data. */
function definitionIn(name, text) {
	const source = ts.createSourceFile(name + ".ts", text, ts.ScriptTarget.Latest, true);
	const value = (node) => {
		if (ts.isAsExpression(node)) {
			return value(node.expression);
		}

		if (ts.isObjectLiteralExpression(node)) {
			return Object.fromEntries(node.properties.map((property) => [property.name.text, value(property.initializer)]));
		}

		return node.text;
	};

	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (declaration.name.text === "definition") {
					return value(declaration.initializer);
				}
			}
		}
	}

	return undefined;
}

/** The Web Awesome elements a source makes, and what they need, transitively. */
function needs(text) {
	const found = new Set();
	const visit = (tag) => {
		if (elements.has(tag) && !found.has(tag)) {
			found.add(tag);
			(elements.get(tag).dependencies ?? []).forEach(visit);
		}
	};

	[...text.matchAll(/"(wa-[a-z-]+)"/gu)].forEach((match) => visit(match[1]));

	return [...found].sort();
}

const files = { "packages/theme/src/web-awesome.ts": generated };

for (const name of components.filter((component) => definitionIn(component, sources[component]) !== undefined)) {
	// (a recipe defines no element)
	const definition = definitionIn(name, sources[name]);

	const className = name.replaceAll(/(?:^|-)(\w)/gu, (_, letter) => letter.toUpperCase());
	const own = [...new Set([...sources[name].matchAll(/(--app-[\w-]+)/gu)].map((match) => match[1]))].sort();

	files[`components/${name}/custom-elements.json`] = JSON.stringify({
		"schemaVersion": "1.0.0",
		"modules": [{
			"kind": "javascript-module",
			"path": "index.js",
			"declarations": [{
				"kind": "class",
				"name": className,
				"tagName": definition.tag,
				"customElement": true,
				"attributes": Object.entries(definition.attributes).map(([attribute, description]) => ({ "name": attribute, "description": description })),
				"slots": Object.entries(definition.slots).map(([slot, description]) => ({ "name": slot, "description": description })),
				"events": Object.entries(definition.events).map(([event, description]) => ({ "name": event, "description": description })),
				"cssProperties": [...own.map((token) => ({ "name": token })), ...tokensIn(sources[name]).filter((token) => tokens[token] !== undefined).map((token) => ({ "name": token, "default": tokens[token] }))],
				// Web Awesome's own field: the elements it makes. Each falls back to its native counterpart when it isn't registered.
				"dependencies": needs(sources[name])
			}],
			"exports": [
				{ "kind": "js", "name": className, "declaration": { "name": className, "module": "index.js" } },
				{ "kind": "custom-element-definition", "name": definition.tag, "declaration": { "name": className, "module": "index.js" } }
			]
		}]
	}, undefined, 2) + "\n";
}

const stale = Object.entries(files).filter(([file, text]) => !fs.existsSync(path.join(root, file)) || read(path.join(root, file)) !== text).map(([file]) => file);

if (process.argv.includes("--check")) {
	if (stale.length > 0) {
		console.error(`Stale, derived from Web Awesome and the components: ${stale.join(", ")}. Run node packages/theme/scripts/web-awesome.mjs.`);
		process.exitCode = 1;
	}
} else {
	for (const file of stale) {
		fs.writeFileSync(path.join(root, file), files[file]);
		console.log("wrote", file);
	}
}
