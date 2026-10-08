// `npm run dev`: rebuild the extension as you change it (Vite's watch build), serve it on this machine, and open the
// editor with it loaded (`?extension=`). The editor follows this server's change stream (`/__changes`) for an extension
// it loaded from this machine, and reloads when a rebuild lands — a save shows in the editor a moment later.
//
//   PORT=5190                                             where it's served
//   EDITOR_URL=https://brianjenkins94.github.io/editor/   which editor opens (your own site loads its deployed copy of
//                                                         the extension too, so the editor's, not yours)
//   NO_OPEN=1                                             don't open a browser
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { build, createServer } from "vite";

const port = Number(process.env.PORT ?? 5190);
const editor = process.env.EDITOR_URL ?? "https://brianjenkins94.github.io/editor/";
const listening = new Set();

const server = await createServer({
	"configFile": false,
	"appType": "custom",
	// 127.0.0.1, not a name: the editor's extension host takes http only from localhost or 127.0.0.1.
	"server": { "host": "127.0.0.1", "port": port, "strictPort": true, "cors": true },
	"plugins": [{
		"name": "extension",
		"configureServer": (vite) => {
			// The extension as it's built — package.json and dist/, as they are on disk — and the change stream.
			vite.middlewares.use((request, response, next) => {
				const path = new URL(request.url, "http://localhost").pathname;

				if (path === "/__changes") {
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
					response.write(": listening\n\n");
					listening.add(response);
					request.on("close", () => { listening.delete(response); });

					return;
				}

				if (path !== "/package.json" && !path.startsWith("/dist/")) {
					next();

					return;
				}

				readFile(new URL("." + path, new URL("../", import.meta.url))).then((body) => {
					response.writeHead(200, { "content-type": path.endsWith(".json") ? "application/json" : "text/javascript", "cache-control": "no-cache", "access-control-allow-origin": "*" });
					response.end(body);
				}, () => {
					response.writeHead(404, { "access-control-allow-origin": "*" });
					response.end();
				});
			});
		}
	}]
});

await server.listen();

// vite.config.mjs's build, again on every change; each rebuild told down the change stream.
const watcher = await build({ "build": { "watch": {} }, "logLevel": "info" });

watcher.on("event", (event) => {
	if (event.code === "END") {
		for (const response of listening) {
			response.write("event: change\ndata: \n\n");
		}
	}
});

const extension = `http://127.0.0.1:${port}/`;
const url = `${editor}?extension=${encodeURIComponent(extension)}`;

console.log(`\n  The extension: ${extension}\n  The editor with it: ${url}\n`);

if (process.env.NO_OPEN === undefined) {
	const [command, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];

	spawn(command, [...args, url], { "stdio": "ignore", "detached": true }).on("error", () => undefined).unref();
}
