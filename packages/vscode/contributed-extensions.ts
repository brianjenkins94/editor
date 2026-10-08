/**
 * Extensions from outside the editor — an interpreter or a code renderer built from editor-contrib's template
 * (contrib/README.md), served from its own site — loaded by URL: `?extension=<url>`, once per extension, the URL its
 * package.json is at or the folder it's in. Its code runs in the web worker extension host, with the access every
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

/** Load the extensions `?extension=` names; resolves once each one is in the editor (or failed to load, and said so). */
export async function loadContributedExtensions(vscode: typeof vscodeApi, log: { "error": (message: string, fields?: Record<string, unknown>) => void }): Promise<void> {
	for (const given of new URLSearchParams(location.search).getAll("extension")) {
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
		} catch (error) {
			log.error("contributed extension failed to load", { "url": base.href, "error": String(error) });
			void vscode.window.showErrorMessage(`Couldn't load the extension at ${base.href}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
