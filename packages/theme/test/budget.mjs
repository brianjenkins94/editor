/**
 * The styling budget (PLAN.md §7.6): what's left outside Web Awesome and the theme, counted, and held to budget.json.
 *
 * - stitchesDeclarations: the declarations in every surface's styles (theme/styles/*, the theme's Stitches calls made
 *   for one surface), and anywhere a Stitches call is still made outside the theme, so a style moved out of a sheet
 *   into a `css({…})` still counts; and in every use-site override (a theme/recipes recipe called with `css`). The
 *   theme's own recipes and components aren't counted: they're the vocabulary.
 * - webawesomeDisables: the `eslint-disable…` comments that turn a webawesome/* rule off.
 *
 * Each may only go down. Over its budget fails, and a raise means editing budget.json, which shows in the diff; under it
 * fails too, until budget.json is lowered to the new count, so the room a removal made can't be spent unseen. The
 * performance budgets (packages/editor/test/performance.mjs) are held in a committed file the same way.
 *
 *     node --test packages/theme/test/budget.mjs
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import * as url from "node:url";
import ts from "typescript";

const budget = JSON.parse(fs.readFileSync(new URL("../budget.json", import.meta.url)));
const root = url.fileURLToPath(new URL("../../../", import.meta.url));

/** The repo's own files (tracked, not the vendored monaco-vscode-api), relative to its root. */
const files = childProcess.execFileSync("git", ["ls-files", "-z"], { "cwd": root, "encoding": "utf8" }).split("\0").filter((file) => file !== "" && !file.startsWith("components/monaco-vscode-api/") && fs.existsSync(root + file));
const read = (file) => fs.readFileSync(root + file, "utf8");
const sources = files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file));

/** The declarations in a file's calls on theme/stitches' css, globalCss, unlayeredGlobalCss and keyframes, and in the
 *  `css` of its recipe calls: every property whose value isn't an object (an object is a nested selector, an at-rule,
 *  a variant or a keyframe). */
function stitchesDeclarations(file) {
	const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
	const names = new Set();
	const recipes = new Set();
	let count = 0;

	for (const statement of source.statements) {
		// (theme/stitches from outside the theme; ../stitches from a surface's styles, theme/styles/*)
		if (ts.isImportDeclaration(statement) && (statement.moduleSpecifier.text === "theme/stitches" || (file.startsWith("packages/theme/src/styles/") && statement.moduleSpecifier.text === "../stitches"))) {
			for (const element of statement.importClause?.namedBindings?.elements ?? []) {
				if (["css", "globalCss", "unlayeredGlobalCss", "keyframes", "stylesheet"].includes((element.propertyName ?? element.name).text)) {
					names.add(element.name.text);
				}
			}
		}

		if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "theme/recipes") {
			for (const element of statement.importClause?.namedBindings?.elements ?? []) {
				recipes.add(element.name.text);
			}
		}
	}

	const styles = (object) => {
		for (const property of object.properties) {
			if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
				styles(property.initializer);
			} else if (ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer)) {
				// compoundVariants: each one's `css`
				for (const element of property.initializer.elements.filter(ts.isObjectLiteralExpression)) {
					styles(element);
				}
			} else if (ts.isPropertyAssignment(property)) {
				count += 1;
			}
		}
	};

	const visit = (node) => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
			for (const argument of node.arguments.filter(ts.isObjectLiteralExpression)) {
				styles(argument);
			}
		}

		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && recipes.has(node.expression.text) && node.arguments[0] !== undefined && ts.isObjectLiteralExpression(node.arguments[0])) {
			const override = node.arguments[0].properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source).replaceAll("\"", "") === "css");

			if (override !== undefined && ts.isObjectLiteralExpression(override.initializer)) {
				styles(override.initializer);
			}
		}

		ts.forEachChild(node, visit);
	};

	if (names.size > 0 || recipes.size > 0) {
		visit(source);
	}

	return count;
}

/** The comments in a file that turn a webawesome/* rule off. */
const disables = (text) => [...text.matchAll(/(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s[^\n]*?webawesome\//gu)].length;

/** Each file's count, and their sum. */
function tally(list, count) {
	const byFile = Object.fromEntries(list.map((file) => [file, count(file)]).filter(([, found]) => found > 0));

	return { "total": Object.values(byFile).reduce((sum, found) => sum + found, 0), "byFile": byFile };
}

const counts = {
	"stitchesDeclarations": tally(sources, stitchesDeclarations),
	"webawesomeDisables": tally(files.filter((file) => /\.(?:css|[cm]?[jt]sx?)$/u.test(file)), (file) => disables(read(file)))
};

for (const [name, { total, byFile }] of Object.entries(counts)) {
	test(`${name}: ${total}, budget ${budget[name]}`, () => {
		const where = Object.entries(byFile).sort(([, left], [, right]) => right - left).map(([file, found]) => `  ${found}\t${file}`).join("\n");

		if (total > budget[name]) {
			throw new Error(`${name} is ${total}, over its budget of ${budget[name]} (packages/theme/budget.json). Take it back down — what Web Awesome or a recipe covers — or raise the budget there, where the diff shows it:\n${where}`);
		}

		if (total < budget[name]) {
			throw new Error(`${name} went down to ${total}, from ${budget[name]}: lower it in packages/theme/budget.json, so the room isn't spent unseen.`);
		}
	});
}
