/**
 * Extensions from outside the editor — an interpreter or a code renderer built from editor-contrib's template
 * (contrib/README.md) — loaded by URL: the URL its package.json is at or the folder it's in. Two lists name them:
 * the site's own `extensions.json` beside its index.html, its URLs relative to the site (a site that's the editor with
 * extensions of its own: editor-contrib's is the editor's tarball, its extension added), and the page's `?extension=`s
 * (one served from anywhere, while it's developed — reloading the editor as it's rebuilt: `followChanges`). Its code runs in the web worker extension host, with the access every
 * extension there has. Its `browser` entry is all that loads: an extension bundles its code into that one file.
 *
 * The extension host's CSP takes its code from https, or http on `localhost:*` / `127.0.0.1:*` (one under
 * development) — not a `*.localhost` name.
 */
import type * as vscodeApi from "vscode";
import { ExtensionHostKind, registerExtension } from "@brianjenkins94/monaco-vscode-api/main";

interface Manifest { "name": string; "publisher": string; "version": string; "browser"?: string }

/** The folder an extension's URL names: its package.json's, or the folder itself — where the extension host's CSP lets
 *  its code come from. */
function folderOf(given: string): URL | undefined {
	try {
		const url = new URL(given);
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

		if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
			return undefined;
		}

		return url.pathname.endsWith("/package.json") ? new URL(".", url) : new URL(url.pathname.endsWith("/") ? url.href : url.href + "/");
	} catch {
		return undefined;
	}
}

/** An extension being developed on this machine (editor-contrib's `npm run dev`): the editor reloads when its change
 *  stream (`__changes`) says it was rebuilt. A server without one is let be — the stream is closed, not retried. */
function followChanges(base: URL): void {
	if (base.protocol !== "http:") {
		return;
	}

	const changes = new EventSource(new URL("__changes", base));
	let opened = false;

	changes.addEventListener("open", () => { opened = true; });
	changes.addEventListener("error", () => {
		if (!opened) {
			changes.close();
		}
	});
	changes.addEventListener("change", () => { window.top?.location.reload(); });
}

/** The site's own extensions (`extensions.json` at its root), as URLs; none when it lists none. */
async function siteExtensions(): Promise<string[]> {
	// The site's root: the workbench is at <root>/__vscode__/host.html.
	const root = new URL(location.pathname.slice(0, location.pathname.indexOf("/__vscode__/") + 1) || "/", location.href);

	try {
		const response = await fetch(new URL("extensions.json", root));
		const listed = response.ok ? await response.json() as unknown : undefined;

		return Array.isArray(listed) ? listed.filter((each): each is string => typeof each === "string").map((each) => new URL(each, root).href) : [];
	} catch {
		return []; // none, or not a list (a dev server answering with its index)
	}
}

/** Load the site's extensions and the ones `?extension=` names; resolves once each one is in the editor (or failed to
 *  load, and said so). */
export async function loadContributedExtensions(vscode: typeof vscodeApi, log: { "error": (message: string, fields?: Record<string, unknown>) => void }): Promise<void> {
	for (const given of new Set([...await siteExtensions(), ...new URLSearchParams(location.search).getAll("extension")])) {
		const base = folderOf(given);

		if (base === undefined) {
			void vscode.window.showErrorMessage(`Not loading the extension at ${given}: an extension loads from https (or http://localhost on this machine).`);
			continue;
		}

		try {
			const response = await fetch(new URL("package.json", base));

			if (!response.ok) {
				throw new Error(`its package.json answered ${response.status}`);
			}

			const manifest = await response.json() as Manifest;

			if (typeof manifest.browser !== "string") {
				throw new TypeError("its package.json names no `browser` entry (a web extension's)");
			}

			const entry = manifest.browser.replace(/^\.\//u, "");

			const extension = registerExtension(manifest, ExtensionHostKind.LocalWebWorker);

			extension.registerFileUrl("./" + entry, new URL(entry, base).href);
			await extension.whenReady();
			followChanges(base);
		} catch (error) {
			log.error("contributed extension failed to load", { "url": base.href, "error": String(error) });
			void vscode.window.showErrorMessage(`Couldn't load the extension at ${base.href}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
