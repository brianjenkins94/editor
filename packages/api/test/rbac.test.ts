/**
 * Roles and permissions (src/rbac.ts). Pure, so it runs anywhere — in the editor's debugger too; admin.test.ts tests
 * the admin endpoints' use of them in workerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PERMISSIONS, permissionsOf } from "../src/rbac.ts";

test("roles map to permissions: the owner holds every one, no role holds none", () => {
	assert.deepEqual(permissionsOf(["owner"]), [...PERMISSIONS]);
	assert.deepEqual(permissionsOf([]), []);
});
