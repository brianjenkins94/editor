/** @jsxImportSource preact */
/**
 * The preview windows, in the shell (the top frame) so they can be dragged anywhere, beyond the editor's iframe: movable
 * windows onto a dev server (`preview.ready`, workbench/node-runner.ts), each an iframe on its address, as many per server
 * as you open. There's no address bar: a window opens on the server's page.
 *
 * Each server's hot updates (`preview.hmr.<port>`) are posted into every window of it, and every frame its app nests, where
 * the dev server's client in the page applies them. Closing a window closes just it, but closing a server's last one stops
 * the server (`preview.close`), which is how a preview is dismissed; a server stopped elsewhere closes its windows.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ShellFeature } from "./feature";
import { appWindow } from "@brianjenkins94/app-window";
import { AppWindow } from "lucide";
import { render } from "preact";
import { previewFrame } from "theme/styles/shell";
import { Icon } from "./icon";
import "theme/components/button";

/** How far each further window of a server opens from the one before it, so none opens exactly over another. */
const CASCADE = 32;
const FIRST_AT = 96;
const WIDTH = 720;
const HEIGHT = 480;

interface Server { "url": string; "windows": Set<HTMLElement>; "opened": number; "offUpdates": () => void }

/** A window's frame and every frame its app nests: each has a client of its own, which acts only on what it loaded. */
function framesUnder(root: Window): Window[] {
	return [root, ...Array.from({ "length": root.frames.length }, (_, index) => framesUnder(root.frames[index]!)).flat()];
}

function install(hub: Hub): void {
	const servers = new Map<number, Server>();

	const open = (port: number): void => {
		const server = servers.get(port);

		if (server === undefined) {
			return;
		}

		const frame = document.createElement("iframe");
		const another = document.createElement("div");
		const at = FIRST_AT + server.opened * CASCADE;

		frame.className = previewFrame();
		frame.title = `Preview :${String(port)}`;
		frame.allow = "cross-origin-isolated";
		frame.src = server.url;
		render(<wa-button appearance="plain" size="small" title="Another window onto this server" aria-label="Another window onto this server" onClick={() => { open(port); }}><Icon node={AppWindow} /></wa-button>, another);

		const element = appWindow({
			"label": `Preview :${String(port)}`,
			"closable": true,
			"width": WIDTH,
			"bodyHeight": HEIGHT,
			"headerActions": [another],
			"children": [frame],
			"onClose": () => {
				element.remove();
				server.windows.delete(element);

				if (server.windows.size === 0) {
					hub.publish("preview.close", { "port": port });
				}
			}
		});

		element.dataset["previewPort"] = String(port);
		element.initialLeft = at;
		element.initialTop = at;
		server.opened += 1;
		server.windows.add(element);
		document.body.append(element);
	};

	hub.subscribe("preview.ready", (data) => {
		const { port, url } = data as { "port": number; "url": string };

		servers.set(port, {
			"url": url,
			"windows": new Set(),
			"opened": 0,
			"offUpdates": hub.subscribe(`preview.hmr.${String(port)}`, (message) => {
				for (const element of servers.get(port)?.windows ?? []) {
					const page = element.querySelector("iframe")?.contentWindow;

					if (page !== null && page !== undefined) {
						for (const target of framesUnder(page)) {
							target.postMessage(message, "*");
						}
					}
				}
			})
		});
		open(port);
	});

	hub.subscribe("preview.close", (data) => {
		const { port } = data as { "port": number };
		const server = servers.get(port);

		if (server !== undefined) {
			server.offUpdates();

			for (const element of server.windows) {
				element.remove();
			}

			servers.delete(port);
		}
	});
}

export const previewWindows: ShellFeature = {
	"start": ({ hub }) => {
		install(hub);
	}
};
