// A debug run's packages (workbench/tarballs.ts): `packages.tarball` answers a package's published tarball at the version
// asked — from the lockfile's URL when versions.json pins that version, else npm's — fetched once a page, its
// dependencies fetched alongside it (not a linked folder's). Over a hub, with a stand-in workspace and network.
import * as assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { installTarballs } from "../workbench/tarballs.ts";

const VERSIONS = {
	"packages": {
		"a": { "version": "1.0.0", "tarball": "https://example.test/a-1.0.0.tgz", "dependencies": ["b", "c"] },
		"b": { "version": "2.0.0" },
		"c": { "version": "3.0.0", "link": "../c" }
	}
};
const files = new Map([[".silo/versions.json", JSON.stringify(VERSIONS)]]);
const relative = (path) => path.replace(/^\/workspace\//u, "");
const vscode = {
	"Uri": { "file": (path) => ({ "path": path }) },
	"workspace": {
		"fs": {
			"readFile": async ({ path }) => {
				if (!files.has(relative(path))) {
					throw new Error("no such file: " + path);
				}

				return new TextEncoder().encode(files.get(relative(path)));
			},
			"stat": async ({ path }) => {
				if (!files.has(relative(path))) {
					throw new Error("no such file: " + path);
				}

				return { "type": 1 };
			}
		}
	}
};

/** Every URL fetched, in order: the network is a stand-in answering each with its own URL's bytes. */
const fetched = [];
const realFetch = globalThis.fetch;
let rpc;

before(() => {
	globalThis.fetch = async (url) => {
		fetched.push(String(url));

		return new Response(new TextEncoder().encode(String(url)));
	};

	const hub = createHub({ "id": "workbench" });

	installTarballs(vscode, hub);
	rpc = createRpcClient(hub);
});

after(() => {
	globalThis.fetch = realFetch;
});

const ask = async (args) => new TextDecoder().decode(await rpc.request("packages.tarball", args, { "timeoutMs": 5000 }));

test("a pinned version comes from the lockfile's URL, and its dependencies are fetched alongside it (not a linked folder)", async () => {
	assert.equal(await ask({ "name": "a", "version": "1.0.0" }), "https://example.test/a-1.0.0.tgz");
	// (the dependencies are asked for first, so they're on their way while the package itself comes)
	assert.deepEqual([...fetched].sort(), ["https://example.test/a-1.0.0.tgz", "https://registry.npmjs.org/b/-/b-2.0.0.tgz"]);
});

test("a tarball is fetched once a page", async () => {
	const before = fetched.length;

	assert.equal(await ask({ "name": "b", "version": "2.0.0" }), "https://registry.npmjs.org/b/-/b-2.0.0.tgz");
	assert.equal(fetched.length, before, "b was prefetched with a: not asked of the network again");
});

test("a version the lockfile doesn't pin comes from npm's registry", async () => {
	assert.equal(await ask({ "name": "a", "version": "0.9.0" }), "https://registry.npmjs.org/a/-/a-0.9.0.tgz");
});

test("it takes a name and a version", async () => {
	await assert.rejects(ask({ "name": "a" }), /a name and a version/u);
});
