/**
 * The dev server's plain files (frameworks/vite-dev-server.ts, dev-server.ts): what isn't transformed — JSON, images,
 * other assets — served from the app's root as it is. An app rooted below the workspace (`/workspace/apps/war2`) used
 * to get every one of them as a 404: the path was resolved against the root twice.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";


const { ViteDevServer } = await import("../frameworks/vite-dev-server.ts");
const { VirtualFS } = await import("../virtual-fs.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function serverAt(root: string): InstanceType<typeof ViteDevServer> {
	const vfs = new VirtualFS();
	const at = (path: string) => (root === "/" ? path : root + path);

	vfs.mkdirSync(at("/src/assets"), { "recursive": true });
	vfs.writeFileSync(at("/src/assets/units.json"), JSON.stringify({ "unit-footman": { "speed": 10 } }));
	vfs.writeFileSync(at("/src/assets/icon.png"), PNG);

	return new ViteDevServer(vfs, { "port": 5173, "root": root });
}

for (const root of ["/", "/workspace/apps/war2"]) {
	test(`rooted at ${root}: a JSON file and an image are served as they are`, async () => {
		const server = serverAt(root);
		const json = await server.handleRequest("GET", "/src/assets/units.json", {});
		const png = await server.handleRequest("GET", "/src/assets/icon.png?v=1", {});

		assert.equal(json.statusCode, 200, String(json.body));
		assert.match(json.headers["Content-Type"]!, /^application\/json/u);
		assert.deepEqual(JSON.parse(String(json.body)), { "unit-footman": { "speed": 10 } });
		assert.equal(png.statusCode, 200, String(png.body));
		assert.deepEqual(new Uint8Array(png.body), PNG);
		assert.equal((await server.handleRequest("GET", "/src/assets/missing.json", {})).statusCode, 404);
	});
}

test("an imported package stylesheet's module: the stylesheet's address in a link, waited for", async () => {
	const server = serverAt("/");
	const module = await server.handleRequest("GET", `/@css?href=${encodeURIComponent("https://esm.sh/x@1.0.0/x.css?external=react")}`, {});

	assert.equal(module.statusCode, 200);
	assert.match(module.headers["Content-Type"]!, /^application\/javascript/u);
	assert.match(String(module.body), /link\.href = "https:\/\/esm\.sh\/x@1\.0\.0\/x\.css\?external=react";/u);

	const own = await server.handleRequest("GET", "/@pkg/@x/look/dist/look.css?import", {});

	assert.match(String(own.body), /link\.href = new URL\("\.\/look\.css", import\.meta\.url\)\.href;/u);
});

test("a page's inline modules have their bare imports rewritten, its other scripts left as they are", async () => {
	const vfs = new VirtualFS();

	vfs.writeFileSync("/package.json", JSON.stringify({ "dependencies": { "left-pad": "1.3.0" } }));
	vfs.writeFileSync("/index.html", "<!doctype html><html><head><script type=\"module\">import pad from \"left-pad\";\nimport \"./own.js\";</script><script>const said = \"import pad from 'left-pad'\";</script></head><body></body></html>");

	const page = String((await new ViteDevServer(vfs, { "port": 5173, "root": "/" }).handleRequest("GET", "/", {})).body);

	assert.match(page, /<script type="module">import pad from "https:\/\/esm\.sh\/left-pad@1\.3\.0[^"]*";\nimport "\.\/own\.js";<\/script><script>const said = "import pad from 'left-pad'";<\/script>/u);
});
