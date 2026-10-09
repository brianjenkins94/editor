// Service or task, from a script's command and name, or a file's source (lifecycle.ts).
import * as assert from "node:assert/strict";
import { test } from "node:test";

import { lifecycleOfScript, lifecycleOfSource } from "../lifecycle.ts";

const script = (name, command) => lifecycleOfScript(name, command).lifecycle;
const source = (code) => lifecycleOfSource(code).lifecycle;

test("a script that serves or watches is a service, whatever it's called", () => {
	assert.equal(script("dev", "vite"), "service");
	assert.equal(script("go", "vite --port 3000"), "service");
	assert.equal(script("preview", "vite preview"), "service");
	assert.equal(script("web", "cd web && vite"), "service");
	assert.equal(script("site", "next dev"), "service");
	assert.equal(script("types", "tsc --watch"), "service");
	assert.equal(script("api", "nodemon server.js"), "service");
	assert.equal(script("server", "tsx watch src/index.ts"), "service");
});

test("a script that builds, tests or checks is a task", () => {
	assert.equal(script("build", "vite build"), "task");
	assert.equal(script("build", "tsc -p ."), "task");
	assert.equal(script("test", "node --test"), "task");
	assert.equal(script("lint", "eslint ."), "task");
	assert.equal(script("ws", "npm -w packages/web run build"), "task");
});

test("otherwise the name decides: dev, start, serve, preview and watch keep running", () => {
	assert.equal(script("start", "node index.js"), "service");
	assert.equal(script("dev:api", "node api.js"), "service");
	assert.equal(script("hello", "node index.js"), "task");
	assert.equal(script("development-notes", "node notes.js"), "task");
});

test("a file that listens, serves, ticks or reads input is a service", () => {
	assert.equal(source("require('http').createServer((q, s) => s.end('hi')).listen(3000);"), "service");
	assert.equal(source("const app = express();\napp.get('/', h);"), "service");
	assert.equal(source("setInterval(() => console.log('tick'), 1000);"), "service");
	assert.equal(source("process.stdin.on('data', echo);"), "service");
	assert.equal(source("new WebSocketServer({ port: 8080 });"), "service");
});

test("a file that just runs is a task — and what's commented out doesn't count", () => {
	assert.equal(source("console.log(1 + 1);"), "task");
	assert.equal(source("setTimeout(() => console.log('later'), 10);"), "task");
	assert.equal(source("// server.listen(3000);\nconsole.log('no');"), "task");
	assert.equal(source("/* setInterval(tick, 1) */ run();"), "task");
	assert.equal(source("fetch('https://example.com/x').then(print);"), "task");
});
