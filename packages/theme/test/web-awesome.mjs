/**
 * What the components need from Web Awesome (src/web-awesome.ts, components/<name>/custom-elements.json) is derived
 * from Web Awesome and the components: it must be current. Fails with how to regenerate it.
 *
 *     node --test packages/theme/test/web-awesome.mjs
 */
import * as childProcess from "node:child_process";
import { test } from "node:test";
import * as url from "node:url";

test("derived from Web Awesome: current", () => {
	childProcess.execFileSync(process.execPath, [url.fileURLToPath(new URL("../scripts/web-awesome.mjs", import.meta.url)), "--check"], { "stdio": "inherit" });
});
