/**
 * Run by build/eslint-toolchain.ts in a child Node: ESLint with the preset (`@brianjenkins94/util/eslint`) lints a small
 * TypeScript project, and every file it loads or reads is written to the trace — what the eslint worker needs of
 * node_modules, and nothing else. Type-aware: the project has a tsconfig, so typescript-eslint's project service (and
 * TypeScript's lib files) are among them.
 *
 *   node build/eslint-toolchain-trace.mjs <fixture dir> <trace.json>
 */
import fs from "node:fs";
import { registerHooks } from "node:module";
import * as url from "node:url";

const [fixture, tracePath] = process.argv.slice(2);
const loaded = new Set();

registerHooks({
	"load": (href, context, next) => {
		if (href.startsWith("file:")) {
			loaded.add(url.fileURLToPath(href));
		}

		return next(href, context);
	}
});

const { readFileSync } = fs;

fs.readFileSync = function(path, ...rest) {
	if (typeof path === "string") {
		loaded.add(path);
	}

	return readFileSync.call(this, path, ...rest);
};

// (the preset resolves its tsconfig against the working directory as it's imported)
process.chdir(fixture);

const { ESLint } = await import("eslint");
const { "default": preset } = await import("@brianjenkins94/util/eslint");
const eslint = new ESLint({ "cwd": fixture, "overrideConfigFile": true, "overrideConfig": preset });
const [result] = await eslint.lintFiles(["src/probe.ts"]);

if (result.messages.some((message) => message.fatal === true)) {
	throw new Error("the trace's lint failed: " + result.messages.map((message) => message.message).join("; "));
}

fs.writeFileSync(tracePath, JSON.stringify([...loaded].sort()));
