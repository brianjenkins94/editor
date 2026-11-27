/**
 * almostnode's own shims (shims/*.ts) as a program uses them, against what Node says where Node has an answer: crypto's
 * randomness and comparisons, zlib's formats (each readable by Node's, and Node's by it), util's callbackify and
 * stripVTControlCharacters, net's isIP; and what a browser can't do saying so — a child process is ENOSYS.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";


const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");

const run = (code: string): unknown => new Runtime(new VirtualFS()).execute(code, "/probe.js").exports;

test("crypto's random values are the right size and differ; randomInt stays in its range; a UUID is v4", () => {
	const [one, other, uuid, ints] = (run(`const crypto = require("crypto"); module.exports = [crypto.randomBytes(16).toString("hex"), crypto.randomBytes(16).toString("hex"), crypto.randomUUID(), Array.from({ length: 200 }, () => crypto.randomInt(5, 10))];`) as [string, string, string, number[]]);

	assert.equal(one.length, 32);
	assert.notEqual(one, other);
	assert.match(uuid, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
	assert.ok(ints.every((each) => Number.isInteger(each) && each >= 5 && each < 10), String(ints));
	assert.equal(new Set(ints).size, 5, "every value in the range comes up");
});

test("crypto.timingSafeEqual says whether two buffers are equal, and refuses two of different lengths, as Node does", async () => {
	const node = await import("node:crypto");
	const said = (run(`const { timingSafeEqual } = require("crypto"); module.exports = [timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")), timingSafeEqual(Buffer.from("abc"), Buffer.from("abd")), (() => { try { timingSafeEqual(Buffer.from("a"), Buffer.from("ab")); return "equal"; } catch (error) { return error.name; } })()];`) as [boolean, boolean, string]);

	assert.deepEqual(said.slice(0, 2), [node.timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")), node.timingSafeEqual(Buffer.from("abc"), Buffer.from("abd"))]);
	assert.equal(said[2], "RangeError");
});

test("crypto.pbkdf2, called back, derives Node's key", async () => {
	const node = await import("node:crypto");
	const derived = await ((run(`module.exports = new Promise((resolve, reject) => require("crypto").pbkdf2("password", "salt", 3, 24, "sha256", (error, key) => error ? reject(error) : resolve(key.toString("hex"))));`) as Promise<string>));

	assert.equal(derived, node.pbkdf2Sync("password", "salt", 3, 24, "sha256").toString("hex"));
});

test("zlib's gzip, deflate and raw deflate: what it compresses Node reads, and what Node compresses it reads, sync or called back", async () => {
	const node = await import("node:zlib");
	const text = "hello almostnode ".repeat(40);
	const [gzipped, deflated, raw] = (run(`const zlib = require("zlib"); const text = ${JSON.stringify(text)}; module.exports = [zlib.gzipSync(text), zlib.deflateSync(text), zlib.deflateRawSync(text)];`) as [Uint8Array, Uint8Array, Uint8Array]);

	assert.equal(node.gunzipSync(gzipped).toString(), text);
	assert.equal(node.inflateSync(deflated).toString(), text);
	assert.equal(node.inflateRawSync(raw).toString(), text);

	const backs = (run(`const zlib = require("zlib"); module.exports = [zlib.gunzipSync(Buffer.from(${JSON.stringify(node.gzipSync(text).toString("base64"))}, "base64")).toString(), zlib.inflateSync(Buffer.from(${JSON.stringify(node.deflateSync(text).toString("base64"))}, "base64")).toString(), zlib.inflateRawSync(Buffer.from(${JSON.stringify(node.deflateRawSync(text).toString("base64"))}, "base64")).toString()];`) as [string, string, string]);

	assert.deepEqual(backs, [text, text, text]);

	const calledBack = await (run(`const zlib = require("zlib"); module.exports = new Promise((resolve, reject) => zlib.gzip(${JSON.stringify(text)}, (error, zipped) => error ? reject(error) : zlib.gunzip(zipped, (again, back) => again ? reject(again) : resolve(back.toString()))));`) as Promise<string>);

	assert.equal(calledBack, text);
});

test("util.callbackify and stripVTControlCharacters say what Node's do", async () => {
	const node = await import("node:util");
	const colored = "\u001B[31mred\u001B[39m and \u001B]8;;https://example.com\u0007a link\u001B]8;;\u0007";
	const [stripped, called] = (run(`const util = require("util"); module.exports = [util.stripVTControlCharacters(${JSON.stringify(colored)}), new Promise((resolve) => util.callbackify(async (a) => a * 2)(21, (error, value) => resolve([error, value])))];`) as [string, Promise<unknown[]>]);

	assert.equal(stripped, node.stripVTControlCharacters(colored));
	assert.deepEqual(await called, [null, 42]);

	const rejected = await (run(`const util = require("util"); module.exports = new Promise((resolve) => util.callbackify(async () => { throw new Error("no"); })((error) => resolve(error.message)));`) as Promise<string>);

	assert.equal(rejected, "no");
});

test("net.isIP: 4, 6 or 0, as Node says", async () => {
	const node = await import("node:net");
	const inputs = ["127.0.0.1", "::1", "fe80::1", "localhost", "1.2.3"];

	assert.deepEqual((run(`const net = require("net"); module.exports = ${JSON.stringify(inputs)}.map((each) => net.isIP(each));`) as number[]), inputs.map((each) => node.isIP(each)));
});

test("a child process can't start here, and says so as Node says a call it can't make: ENOSYS, called back or thrown", async () => {
	const [thrown, spawned] = (run(`const cp = require("child_process"); module.exports = [(() => { try { cp.execSync("ls"); return "ran"; } catch (error) { return error.code; } })(), (() => { const result = cp.spawnSync("ls"); return result.error?.code ?? String(result.status); })()];`) as [string, string]);

	assert.equal(thrown, "ENOSYS");
	assert.equal(spawned, "ENOSYS");

	const calledBack = await (run(`module.exports = new Promise((resolve) => require("child_process").exec("ls", (error) => resolve(error.code + " " + error.syscall)));`) as Promise<string>);

	assert.equal(calledBack, "ENOSYS exec");
});
