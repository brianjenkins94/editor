/**
 * Every extension loads from a folder: its package.json, its `browser` entry, and the files its manifest's `files`
 * lists (a worker it starts, a tsserver plugin's package, a webview's script) — each registered at its path in the
 * folder, so the extension opens it as `extensionUri`'s (registerExtensionFolder). The editor's own are built into
 * `extensions/<name>/` (build.ts, bundledExtension) and registered by workbench-entry; extensions from outside the
 * editor — an interpreter or a code renderer built from editor-contrib's template (contrib/README.md) — the same way,
 * by URL: the URL its package.json is at or the folder it's in. Two lists name those: the site's own `extensions.json`
 * beside its index.html, its URLs relative to the site (a site that's the editor with extensions of its own:
 * editor-contrib's is the editor's tarball, its extension added), and the page's `?extension=`s (one served from
 * anywhere, while it's developed — reloading the editor as it's rebuilt: `followChanges`). Their code runs in the web
 * worker extension host, with the access every extension there has.
 *
 * The extension host's CSP takes its code from https, or http on `localhost:*` / `127.0.0.1:*` (one under
 * development) — not a `*.localhost` name.
 */
import type * as vscodeApi from "vscode";
import { ExtensionHostKind, registerExtension } from "@brianjenkins94/monaco-vscode-api/main";

/** A manifest (VS Code's), its entry and the files it lists. */
type Manifest = Parameters<typeof registerExtension>[0] & { "browser"?: string; "files"?: unknown };

/** An extension in its folder (`base`): registered in host `kind`, its entry and its manifest's `files` at their paths
 *  in it. A `files` entry is a file's path in the folder — not a pattern, nor a folder. */
export function registerExtensionFolder(manifest: Manifest, base: URL, kind: ExtensionHostKind): ReturnType<typeof registerExtension> {
	if (typeof manifest.browser !== "string") {
		throw new TypeError("its package.json names no `browser` entry (a web extension's)");
	}

	const files = Array.isArray(manifest.files) ? manifest.files : [];
	const odd = files.find((file) => typeof file !== "string" || file === "" || file.endsWith("/") || /[*?]/u.test(file));

	if (odd !== undefined) {
		throw new TypeError(`its package.json's files lists ${JSON.stringify(odd)}: each is a file's path in its folder`);
	}

	const extension = registerExtension(manifest, kind);

	for (const file of [manifest.browser, ...files as string[]].map((each) => each.replace(/^\.\//u, ""))) {
		extension.registerFileUrl("./" + file, new URL(file, base).href);
	}

	return extension;
}

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

	changes.addEventListener("open", () => {
		opened = true;
	});
	changes.addEventListener("error", () => {
		if (!opened) {
			changes.close();
		}
	});
	changes.addEventListener("change", () => {
		window.top?.location.reload();
	});
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
		} else {
			try {
				const response = await fetch(new URL("package.json", base));

				if (!response.ok) {
					throw new Error(`its package.json answered ${response.status}`);
				}

				await registerExtensionFolder(await response.json() as Manifest, base, ExtensionHostKind.LocalWebWorker).whenReady();
				followChanges(base);
			} catch (error) {
				log.error("contributed extension failed to load", { "url": base.href, "error": String(error) });
				void vscode.window.showErrorMessage(`Couldn't load the extension at ${base.href}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}
