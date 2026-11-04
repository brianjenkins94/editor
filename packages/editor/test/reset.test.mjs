// Resetting the editor (shell/reset.ts): what it deletes is the editor's alone — on GitHub Pages the origin is shared.
import * as assert from "node:assert/strict";
import { test } from "node:test";

import { editorStores } from "../shell/reset.ts";

// An origin's databases and keys as a browser that's had the editor, and another site on the same origin, would hold.
const DATABASES = ["workspace-fs", "silo-local", "bablr", "editor-session", "vscode-web-db", "vscode-web-state-db-global", "games-saves", "keyval-store"];
const KEYS = ["shell:session", "shell:signIn", "shell:navWidth", "shell:githubRepo", "pane.native", "architecture.collapsed", "monaco-parts-splash", "DefaultOverridesCacheExists", "debug", "war2:settings", "theme"];

test("a reset takes the editor's databases and keys, and keeps the sign-in", () => {
	const { databases, keys } = editorStores(DATABASES, KEYS, false);

	assert.deepEqual(databases, ["workspace-fs", "silo-local", "bablr", "vscode-web-db", "vscode-web-state-db-global"]);
	assert.deepEqual(keys, ["shell:navWidth", "shell:githubRepo", "pane.native", "architecture.collapsed", "monaco-parts-splash", "DefaultOverridesCacheExists", "debug"]);
});

test("signing out too takes the sign-in's database and keys", () => {
	const { databases, keys } = editorStores(DATABASES, KEYS, true);

	assert.ok(databases.includes("editor-session"));
	assert.ok(keys.includes("shell:session") && keys.includes("shell:signIn"));
});

test("nothing of another site's on the origin is touched", () => {
	const { databases, keys } = editorStores(DATABASES, KEYS, true);

	assert.ok(!databases.includes("games-saves") && !databases.includes("keyval-store"));
	assert.ok(!keys.includes("war2:settings") && !keys.includes("theme"));
});

test("resetting the real editor takes its instances with it", () => {
	const { databases, keys } = editorStores(["instance:one:workspace-fs", "someone-elses"], ["instance:one:shell:navWidth", "someone-elses"], false);

	assert.deepEqual(databases, ["instance:one:workspace-fs"]);
	assert.deepEqual(keys, ["instance:one:shell:navWidth"]);
});
