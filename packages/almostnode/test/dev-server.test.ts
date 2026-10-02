/**
 * The dev server's plain files (frameworks/vite-dev-server.ts, dev-server.ts): what isn't transformed — JSON, images,
 * other assets — served from the app's root as it is. An app rooted below the workspace (`/workspace/apps/war2`) used
 * to get every one of them as a 404: the path was resolved against the root twice.
 */
import * as assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// (almostnode's sources import each other without extensions: see extensionless.mjs.)
register("./extensionless.mjs", import.meta.url);

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
