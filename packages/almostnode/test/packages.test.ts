/**
 * The dev server's package resolution (frameworks/packages.ts): registry deps → esm.sh, URL/tarball deps fetched,
 * unpacked and served under /@pkg/, and bare imports rewritten to relative URLs (so they resolve in workers too).
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import pako from "pako";
import ts from "typescript";
import type { Manifest } from "../frameworks/packages.ts";
import { isBare, PackageResolver, relativeUrl, resolveEntry, splitSpecifier, untar } from "../frameworks/packages.ts";

/** A gzipped ustar archive of `files` under `package/` — what a published tarball looks like. */
function tarball(files: Record<string, string>, { longPaths = false } = {}): Uint8Array {
	const blocks: Uint8Array[] = [];
	const header = (name: string, size: number, type: string): Uint8Array => {
		const block = new Uint8Array(512);
		const write = (text: string, offset: number): void => { block.set(new TextEncoder().encode(text), offset); };

		write(name.slice(0, 100), 0);
		write("0000644\0", 100);
		write(size.toString(8).padStart(11, "0") + "\0", 124);
		write(type, 156);
		write("ustar\u000000", 257);

		return block;
	};
	const padded = (bytes: Uint8Array): Uint8Array => {
		const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);

		out.set(bytes);

		return out;
	};

	for (const [path, content] of Object.entries(files)) {
		const body = new TextEncoder().encode(content);
		const fullPath = "package/" + path;

		if (longPaths) {
			const record = ` path=${fullPath}\n`;
			const pax = new TextEncoder().encode(`${record.length + String(record.length).length}${record}`);

			blocks.push(header("PaxHeader", pax.length, "x"), padded(pax));
		}

		blocks.push(header(longPaths ? "truncated" : fullPath, body.length, "0"), padded(body));
	}

	blocks.push(new Uint8Array(1024));

	const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
	let offset = 0;

	for (const block of blocks) {
		archive.set(block, offset);
		offset += block.length;
	}

	return pako.gzip(archive);
}

const HUB = "https://pages.example/hub@latest.tgz";
const UTIL = "https://pages.example/util@latest.tgz";
const OBS = "https://pages.example/observability@latest.tgz";

const packages: Record<string, Record<string, string>> = {
	[HUB]: {
		"package.json": JSON.stringify({ "name": "@x/hub", "exports": { ".": "./index.js" } }),
		"index.js": "export const hub = 1;\n"
	},
	[UTIL]: {
		"package.json": JSON.stringify({ "name": "@x/util", "exports": { "./logger": { "types": "./logger.d.ts", "default": "./logger.js" } } }),
		"logger.js": "export const logger = 1;\n"
	},
	[OBS]: {
		"package.json": JSON.stringify({ "name": "@x/observability", "exports": { ".": "./index.js" }, "peerDependencies": { "@x/hub": "*", "@x/util": "*" }, "dependencies": { "left-pad": "^1.3.0" } }),
		"index.js": "import { hub } from \"@x/hub\";\nimport { logger } from \"@x/util/logger\";\nimport pad from \"left-pad\";\nexport * from \"./src/more.js\";\n",
		"src/more.js": "export const more = 1;\n"
	}
};

function resolver(manifest: Manifest = { "dependencies": { "react": "^19.0.0", "@x/hub": HUB, "@x/observability": OBS }, "devDependencies": { "@x/util": UTIL } }) {
	const fetched: string[] = [];
	const fake = (async (url: string) => {
		fetched.push(url);

		return packages[url] === undefined ? new Response("nope", { "status": 404 }) : new Response(tarball(packages[url]));
	}) as typeof fetch;

	return { "packages": new PackageResolver({ "manifest": () => manifest, "fetch": fake }), "fetched": fetched };
}

test("specifiers: package names (scoped or not) and subpaths; what counts as bare", () => {
	assert.deepEqual(splitSpecifier("@x/hub"), { "name": "@x/hub", "subpath": "." });
	assert.deepEqual(splitSpecifier("@x/util/logger"), { "name": "@x/util", "subpath": "./logger" });
	assert.deepEqual(splitSpecifier("react/jsx-runtime"), { "name": "react", "subpath": "./jsx-runtime" });
	assert.ok(isBare("react") && isBare("@x/hub"));
	assert.ok(!isBare("./a.js") && !isBare("/a.js") && !isBare("https://esm.sh/react") && !isBare("node:fs") && !isBare("data:text/javascript,"));
	assert.equal(relativeUrl("/src/browser/page.ts", "/@pkg/@x/hub/index.js"), "../../@pkg/@x/hub/index.js");
	assert.equal(relativeUrl("/@pkg/@x/observability/index.js", "/@pkg/@x/hub/index.js"), "../hub/index.js");
	assert.equal(relativeUrl("/main.ts", "/@pkg/@x/hub/index.js"), "./@pkg/@x/hub/index.js");
});

test("untar drops the package/ prefix, and follows pax long paths", () => {
	const files = untar(pako.ungzip(tarball({ "a.js": "A", "deep/b.js": "B" })));

	assert.deepEqual([...files.keys()], ["a.js", "deep/b.js"]);
	assert.equal(new TextDecoder().decode(files.get("deep/b.js")), "B");

	const long = untar(pako.ungzip(tarball({ ["x/".repeat(60) + "c.js"]: "C" }, { "longPaths": true })));

	assert.deepEqual([...long.keys()], ["x/".repeat(60) + "c.js"]);
});

test("a package's entry comes from its exports (browser/import conditions), else module/main", () => {
	assert.equal(resolveEntry({ "exports": { "./logger": { "types": "./logger.d.ts", "default": "./logger.js" } } }, "./logger"), "logger.js");
	assert.equal(resolveEntry({ "exports": { ".": { "browser": "./b.js", "node": "./n.js", "default": "./d.js" } } }, "."), "b.js");
	assert.equal(resolveEntry({ "exports": { ".": "./index.js" } }, "./missing"), undefined);
	assert.equal(resolveEntry({ "module": "./esm.js", "main": "./cjs.js" }, "."), "esm.js");
	assert.equal(resolveEntry({}, "."), "index.js");
});

test("registry deps resolve to esm.sh; tarball deps (dependencies or devDependencies) to /@pkg/; undeclared ones to nothing", async () => {
	const { packages: resolve } = resolver();

	assert.equal(await resolve.resolve("react", "/src/a.ts"), "https://esm.sh/react@^19.0.0");
	assert.equal(await resolve.resolve("react/jsx-runtime", "/src/a.ts"), "https://esm.sh/react@^19.0.0/jsx-runtime");
	assert.equal(await resolve.resolve("@x/hub", "/src/a.ts"), "/@pkg/@x/hub/index.js");
	assert.equal(await resolve.resolve("@x/util/logger", "/src/a.ts"), "/@pkg/@x/util/logger.js", "a devDependency, through its exports");
	assert.equal(await resolve.resolve("nothing", "/src/a.ts"), undefined);
});

test("a package's files are served, and its own imports resolve: peers to the app's, its dependencies to its own", async () => {
	const { packages: resolve } = resolver();

	await resolve.resolve("@x/observability", "/src/a.ts");

	assert.equal(new TextDecoder().decode(await resolve.file("/@pkg/@x/observability/src/more.js")), "export const more = 1;\n");
	assert.equal(await resolve.file("/@pkg/@x/observability/missing.js"), undefined);
	assert.equal(await resolve.file("/@pkg/@x/never-resolved/index.js"), undefined);

	const code = new TextDecoder().decode(await resolve.file("/@pkg/@x/observability/index.js"));
	const rewritten = await resolve.rewriteImports(code, "/@pkg/@x/observability/index.js", ts);

	assert.equal(rewritten, "import { hub } from \"../hub/index.js\";\nimport { logger } from \"../util/logger.js\";\nimport pad from \"https://esm.sh/left-pad@^1.3.0\";\nexport * from \"./src/more.js\";\n");
});

test("rewriteImports: static, re-exported and dynamic bare imports become relative URLs; relative, URL and unknown ones stay", async () => {
	const { packages: resolve } = resolver();
	const code = [
		"import { hub } from \"@x/hub\";",
		"export { logger } from '@x/util/logger';",
		"import \"./side-effect.js\";",
		"import React from \"react\";",
		"import x from \"https://cdn.example/x.js\";",
		"import y from \"undeclared\";",
		"const later = await import(\"@x/hub\");"
	].join("\n");

	assert.equal(await resolve.rewriteImports(code, "/src/browser/page.ts", ts), [
		"import { hub } from \"../../@pkg/@x/hub/index.js\";",
		"export { logger } from '../../@pkg/@x/util/logger.js';",
		"import \"./side-effect.js\";",
		"import React from \"https://esm.sh/react@^19.0.0\";",
		"import x from \"https://cdn.example/x.js\";",
		"import y from \"undeclared\";",
		"const later = await import(\"../../@pkg/@x/hub/index.js\");"
	].join("\n"));
});

test("a tarball is fetched once, however often it's asked for; a failed fetch is tried again", async () => {
	const { packages: resolve, fetched } = resolver({ "dependencies": { "@x/hub": HUB, "@x/gone": "https://pages.example/gone.tgz" } });

	await Promise.all([resolve.resolve("@x/hub", "/a.ts"), resolve.resolve("@x/hub", "/b.ts"), resolve.file("/@pkg/@x/hub/index.js")]);
	assert.deepEqual(fetched, [HUB]);

	await assert.rejects(resolve.resolve("@x/gone", "/a.ts"), /answered 404/u);
	await assert.rejects(resolve.resolve("@x/gone", "/a.ts"), /answered 404/u);
	assert.equal(fetched.filter((url) => url.includes("gone")).length, 2);
});
