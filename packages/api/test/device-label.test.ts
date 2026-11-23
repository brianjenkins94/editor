/**
 * A session's device label (src/account.ts `deviceLabel`): the browser and the OS from its user agent, nothing more.
 * Pure, so it runs anywhere — in the editor's debugger too; account.test.ts tests the account endpoints in workerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deviceLabel } from "../src/account.ts";

test("a device label is the browser and the OS, nothing more", () => {
	assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome on macOS");
	assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge on Windows");
	assert.equal(deviceLabel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
	assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"), "Firefox on Linux");
	assert.equal(deviceLabel(undefined), undefined);
});
