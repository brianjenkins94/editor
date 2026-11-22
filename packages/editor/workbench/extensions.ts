import type * as vscodeApi from "vscode";
import { ExtensionHostKind, registerExtension } from "@brianjenkins94/monaco-vscode-api/main";

type Manifest = Parameters<typeof registerExtension>[0] & { "browser"?: string; "files"?: unknown };

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

function folderOf(given: string): URL | undefined {
	try {
		const url = new URL(given, location.href);
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

		if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
			return undefined;
		}

		return url.pathname.endsWith("/package.json") ? new URL(".", url) : new URL(url.pathname.endsWith("/") ? url.href : url.href + "/");
	} catch {
		return undefined;
	}
}

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

async function siteExtensions(): Promise<string[]> {
	const root = new URL(location.pathname.slice(0, location.pathname.indexOf("/__vscode__/") + 1) || "/", location.href);

	try {
		const response = await fetch(new URL("extensions.json", root));
		const listed = response.ok ? await response.json() as unknown : undefined;

		return Array.isArray(listed) ? listed.filter((each): each is string => typeof each === "string").map((each) => new URL(each, root).href) : [];
	} catch {
		return []; // none, or not a list (a dev server answering with its index)
	}
}

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
