// The workspace's pinned versions (workbench/versions.ts): an npm alias (`"typescript-7": "npm:typescript@…"`, silo's own
// TypeScript beside a root's older one) is resolved as the package it names, and kept under its own name with that
// package's tarball — so a debug run installs the right package by the alias's name, and the CDN is asked for the real
// one. With deps.dev and npm's registry stood in.
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { aliasOf, lockedVersions, packagesNotFound, resolveVersions } from "../workbench/versions.ts";

function json(body) {
	return new Response(JSON.stringify(body), {
		"headers": { "content-type": "application/json" }
	});
}

const PUBLISHED = {
	"typescript": [
		{
			"versionKey": { "version": "6.0.3" },
			"publishedAt": "2026-09-01T00:00:00Z",
			"isDefault": true
		},
		{
			"versionKey": { "version": "7.1.0-dev.20261107.1" },
			"publishedAt": "2026-11-07T08:07:13Z"
		}
	]
};

test("an npm alias's range names the package and that package's range", () => {
	assert.deepEqual(aliasOf("npm:typescript@7.1.0-dev.20261107.1"), { "name": "typescript", "range": "7.1.0-dev.20261107.1" });
	assert.deepEqual(aliasOf("npm:@scope/pkg@^2"), { "name": "@scope/pkg", "range": "^2" });
	assert.deepEqual(aliasOf("npm:pkg"), { "name": "pkg", "range": "latest" });
	assert.equal(aliasOf("^1.2.0"), undefined);
	assert.equal(aliasOf("file:../theme"), undefined);
});

test("an alias resolves as the package it names, beside that package's own version, with that package's tarball", async () => {
	const fetched = [];
	const real = globalThis.fetch;

	globalThis.fetch = async (url) => {
		fetched.push(String(url));

		const name = String(url).match(/packages\/(.+)$/u)?.[1];

		if (name !== undefined) {
			return PUBLISHED[decodeURIComponent(name)] === undefined
				? new Response("", { "status": 404 })
				: json({ "versions": PUBLISHED[decodeURIComponent(name)] });
		}

		return String(url).startsWith("https://registry.npmjs.org/typescript/")
			? json({ "name": "typescript" })
			: new Response("", { "status": 404 });
	};

	try {
		const resolved = await resolveVersions({ "typescript": "^6", "typescript-7": "npm:typescript@7.1.0-dev.20261107.1" }, {
			"now": Date.parse("2026-11-15T00:00:00Z")
		});

		assert.equal(resolved["typescript"]?.version, "6.0.3");
		assert.deepEqual(resolved["typescript-7"], {
			"version": "7.1.0-dev.20261107.1",
			"range": "npm:typescript@7.1.0-dev.20261107.1",
			"alias": "typescript",
			"tarball": "https://registry.npmjs.org/typescript/-/typescript-7.1.0-dev.20261107.1.tgz",
			"dependencies": []
		});
		assert.ok(!fetched.some((url) => url.includes("typescript-7")), "nothing asks for a package called typescript-7");
	} finally {
		globalThis.fetch = real;
	}
});

test("a dependency's range the version kept by its name doesn't satisfy is nested, at its own, under the package that asked", async () => {
	const at = (version, date) => ({ "versionKey": { "version": version }, "publishedAt": date });
	const published = {
		"ignore": [at("5.3.2", "2024-08-01T00:00:00Z"), at("7.0.5", "2026-01-01T00:00:00Z")],
		"isomorphic-git": [at("1.30.0", "2026-01-01T00:00:00Z")]
	};
	const manifests = { "isomorphic-git/1.30.0": { "dependencies": { "ignore": "^5.1.4" } }, "ignore/7.0.5": {}, "ignore/5.3.2": {} };
	const real = globalThis.fetch;

	globalThis.fetch = async (url) => {
		const name = String(url).match(/systems\/npm\/packages\/(.+)$/u)?.[1];

		if (name !== undefined) {
			return json({ "versions": published[decodeURIComponent(name)] ?? [] });
		}

		const manifest = manifests[String(url).replace("https://registry.npmjs.org/", "")];

		return manifest === undefined ? new Response("", { "status": 404 }) : json(manifest);
	};

	try {
		const resolved = await resolveVersions({ "ignore": "^7", "isomorphic-git": "^1" }, { "now": Date.parse("2026-11-15T00:00:00Z") });

		assert.equal(resolved.ignore.version, "7.0.5");
		assert.deepEqual(resolved["isomorphic-git"].nested, { "ignore": "5.3.2" });
		assert.equal(resolved.ignore.nested, undefined, "one whose ranges the kept versions satisfy has none");
	} finally {
		globalThis.fetch = real;
	}
});

test("a lockfile's package nested a level down under the one that asked is on that one's entry", () => {
	const locked = lockedVersions({ "packages": {
		"": {},
		"node_modules/ignore": { "version": "7.0.12" },
		"node_modules/isomorphic-git": { "version": "1.30.0", "dependencies": { "ignore": "^5.1.4" } },
		"node_modules/isomorphic-git/node_modules/ignore": { "version": "5.3.2" }
	} });

	assert.equal(locked.ignore.version, "7.0.12");
	assert.deepEqual(locked["isomorphic-git"].nested, { "ignore": "5.3.2" });
});

test("the packages TypeScript says it can't find: an import's, a tsconfig's types and what it extends, whose errors have no code; a file of the workspace's is no package's", () => {
	assert.deepEqual(packagesNotFound("Cannot find module 'nanoid/non-secure' or its corresponding type declarations."), ["nanoid"]);
	assert.deepEqual(packagesNotFound("Cannot find module '@scope/name/deep'. Did you mean to set the 'moduleResolution' option to 'nodenext', or to add aliases to the 'paths' option?"), ["@scope/name"]);
	assert.deepEqual(packagesNotFound("Cannot find type definition file for 'vite/client'.\n  The file is in the program because:"), ["vite", "@types/vite"]);
	assert.deepEqual(packagesNotFound("File '@tsconfig/node-lts/tsconfig.json' not found."), ["@tsconfig/node-lts"]);
	assert.deepEqual(packagesNotFound("Type 'string' is not assignable to type 'number'."), []);
	assert.deepEqual(packagesNotFound("Property 'x' does not exist: Cannot find module 'nanoid'"), []);
});
