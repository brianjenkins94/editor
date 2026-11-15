// The workspace's pinned versions (workbench/versions.ts): an npm alias (`"typescript-7": "npm:typescript@…"`, silo's own
// TypeScript beside a root's older one) is resolved as the package it names, and kept under its own name with that
// package's tarball — so a debug run installs the right package by the alias's name, and the CDN is asked for the real
// one. With deps.dev and npm's registry stood in.
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { aliasOf, resolveVersions } from "../workbench/versions.ts";

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
