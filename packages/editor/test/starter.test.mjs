/**
 * The starter workspace (build/snapshot.ts): `demo/` baked into the build as `editor:workspace` — each text file under
 * /workspace, the root configs the editor manages read-only, nothing else (no node_modules) — and the editor's settings
 * defaults (settings-defaults.jsonc) as `editor:settings-defaults`, the lowest settings layer. What a fresh editor
 * opens on; workbench.mjs sees it opened.
 *
 *   node --import tsx --test test/starter.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import ts from "typescript";

const { editorSettingsDefaultsPlugin, editorWorkspacePlugin } = await import("../build/snapshot.ts");

const DEMO = path.join(import.meta.dirname, "../demo");

/** A virtual module as Vite gets it from `plugin`: resolved, then loaded, its default export's value. */
const load = (plugin, id) => {
	const resolved = plugin.resolveId(id);

	assert.ok(resolved !== undefined, `${plugin.name} resolves ${id}`);

	return JSON.parse(/^export default (.*);$/su.exec(plugin.load(resolved))[1]);
};

/** Every file under `dir` by its path from it, node_modules left out. */
const filesUnder = (dir, prefix = "") => readdirSync(dir).flatMap((name) => {
	const at = path.join(dir, name);

	if (name === "node_modules") {
		return [];
	}

	return statSync(at).isDirectory() ? filesUnder(at, prefix + name + "/") : [prefix + name];
});

test("the starter is demo/, each file at its path under /workspace with its text; the root's managed configs read-only", () => {
	const files = load(editorWorkspacePlugin(), "editor:workspace");

	assert.deepEqual(files.map((file) => file.path), filesUnder(DEMO).map((file) => "/workspace/" + file).toSorted((one, other) => one.localeCompare(other)));

	for (const file of files) {
		assert.equal(file.contents, readFileSync(path.join(DEMO, file.path.slice("/workspace/".length)), "utf8"), file.path);
	}

	assert.deepEqual(files.filter((file) => file.readonly).map((file) => file.path), ["/workspace/tsconfig.json"], "the root tsconfig is the editor's; a nested app's files are the user's");
});

test("the editor's settings defaults are settings-defaults.jsonc's, comments and all", () => {
	const defaults = load(editorSettingsDefaultsPlugin(), "editor:settings-defaults");

	const file = path.join(import.meta.dirname, "../settings-defaults.jsonc");

	assert.deepEqual(defaults, ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8")).config);
	assert.equal(defaults["[javascript][javascriptreact][typescript][typescriptreact]"]["editor.formatOnSave"], true);
});
