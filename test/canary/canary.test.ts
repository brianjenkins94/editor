import { test } from "node:test";
import assert from "node:assert";
import { runCanary } from "../../src/canary.ts";

test("stays green when runtime capabilities are within the predicted set", () => {
	const r = runCanary(`fetch("https://api.example.com/data")`, { predicted: ["net"] });
	assert.ok(r.ok && !r.aborted);
	assert.deepStrictEqual(r.observedCaps, ["net"]);
	assert.strictEqual(r.observed[0].value, "https://api.example.com/data");
});

test("hard-aborts when runtime reaches an unpredicted capability", () => {
	const r = runCanary(`fetch("https://evil.com")`, { predicted: [] });
	assert.ok(!r.ok && r.aborted);
	assert.strictEqual(r.divergence?.capability, "net");
	assert.strictEqual(r.divergence?.value, "https://evil.com");
});

test("catches sneaky constructions: aliasing, string-concat reflection, Reflect.get", () => {
	for (const code of [`const f = fetch; f("https://x")`, `globalThis["fe" + "tch"]("https://y")`, `self.fetch("https://z")`, `Reflect.get(globalThis, "fetch")("https://w")`]) {
		const r = runCanary(code, { predicted: [] });
		assert.ok(r.aborted, `expected divergence for: ${code}`);
		assert.strictEqual(r.divergence?.capability, "net");
	}
});

test("the tripwire is uncatchable by guest try/catch", () => {
	const r = runCanary(`try { fetch("https://z"); } catch (e) { /* swallow */ } "survived"`, { predicted: [] });
	assert.ok(r.aborted, "guest try/catch must not swallow the abort");
	assert.notStrictEqual(r.completion, "survived");
});

test("fs:write via import is caught; fs:read declared is allowed", () => {
	const write = runCanary(`import fs from "node:fs"; fs.writeFileSync("/etc/passwd", "x")`, { predicted: ["net"] });
	assert.strictEqual(write.divergence?.capability, "fs:write");
	assert.strictEqual(write.divergence?.value, "/etc/passwd");

	const read = runCanary(`import { readFileSync } from "node:fs"; readFileSync("/tmp/a")`, { predicted: ["fs:read"] });
	assert.ok(read.ok);
	assert.deepStrictEqual(read.observedCaps, ["fs:read"]);
});

test("coarse predicted `fs` covers granular fs:read/fs:write", () => {
	const r = runCanary(`import fs from "fs"; fs.readFileSync("/a"); fs.writeFileSync("/b", "c")`, { predicted: ["fs"] });
	assert.ok(r.ok, "coarse fs should cover fs:read and fs:write");
	assert.deepStrictEqual(r.observedCaps, ["fs:read", "fs:write"]);
});

test("exec and env reaches are caught", () => {
	const exec = runCanary(`import cp from "node:child_process"; cp.execSync("rm -rf /")`, { predicted: [] });
	assert.strictEqual(exec.divergence?.capability, "exec");
	assert.strictEqual(exec.divergence?.value, "rm -rf /");

	const env = runCanary(`process.env.AWS_SECRET_KEY`, { predicted: [] });
	assert.strictEqual(env.divergence?.capability, "env");
	assert.strictEqual(env.divergence?.value, "AWS_SECRET_KEY");
});

test("Axis-2: the concrete resource is resolved at runtime even when static can't", () => {
	const r = runCanary(`const host = "internal-" + "service"; fetch("https://" + host + ".corp/api")`, { predicted: ["net"] });
	assert.strictEqual(r.observed[0].value, "https://internal-service.corp/api");
});

test("pure computation reaches no capabilities", () => {
	const r = runCanary(`const x = [1, 2, 3].map((n) => n * n).reduce((a, b) => a + b, 0); x`, { predicted: [] });
	assert.ok(r.ok);
	assert.strictEqual(r.completion, 14);
	assert.deepStrictEqual(r.observedCaps, []);
});

test("records multiple reaches in order up to the first divergence", () => {
	const r = runCanary(`fetch("https://a"); fetch("https://b"); process.env.X;`, { predicted: ["net"] });
	assert.ok(r.aborted);
	assert.deepStrictEqual(
		r.observed.map((e) => e.value),
		["https://a", "https://b", "X"],
	);
	assert.strictEqual(r.divergence?.capability, "env");
});
