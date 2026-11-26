/**
 * `vite`, as a program run in the editor has it: a server it starts is the editor's in-browser dev server, as the
 * terminal's `vite` starts (the debug worker's `__editorPlaywright.devServer`), on the folder asked for (`root`, else the
 * program's). `preview()` serves the project as it is, not a build of it: there's no `vite build` in the editor.
 *
 * What's here: `preview` and `createServer` (its `listen`), each with `resolvedUrls` and `close`; `defineConfig`,
 * `loadEnv` (nothing loaded), `mergeConfig`. Not here: `build`, and the plugin and transform APIs.
 */
"use strict";

const path = require("node:path");

const host = globalThis.__editorPlaywright;

async function serve(config = {}) {
	if (host === undefined) {
		throw new Error("vite runs in the editor's debugger, as its in-browser dev server: there's none here");
	}

	const root = path.resolve(process.cwd(), config.root ?? ".");
	const server = await host.devServer(root);

	return {
		"config": { "root": root },
		"resolvedUrls": { "local": [server.url], "network": [] },
		"printUrls": () => {
			process.stdout.write(`  Local:  ${server.url}\n`);
		},
		"close": async () => server.stop()
	};
}

async function createServer(config = {}) {
	let started;

	return {
		"config": { "root": path.resolve(process.cwd(), config.root ?? ".") },
		get "resolvedUrls"() {
			return started?.resolvedUrls ?? null;
		},
		"listen": async function () {
			started ??= await serve(config);

			return this;
		},
		"printUrls": () => started?.printUrls(),
		"close": async () => started?.close()
	};
}

const notHere = (name) => () => {
	throw new Error(`vite's ${name} isn't in the editor: its dev server is (preview, createServer)`);
};

module.exports = {
	"preview": serve,
	"createServer": createServer,
	"defineConfig": (config) => config,
	"mergeConfig": (defaults, overrides) => ({ ...defaults, ...overrides }),
	"loadEnv": () => ({}),
	"build": notHere("build")
};
