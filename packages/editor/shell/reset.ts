/**
 * Resetting the editor: everything this browser keeps for it, gone, so the next load is a first one — the workspace and
 * its git, VS Code's own state, BABLR's parses, silo's local records, the shell's settings — and its service worker
 * unregistered. The sign-in stays, unless asked to go too (`?reset=all`).
 *
 * It runs from the address (`?reset`), first thing (main.tsx), before the service worker or the workbench start: nothing
 * in this tab holds a database open then, and an editor too broken to open still resets. The shell's Reset button
 * confirms, then goes there. Only the editor's stores, named: on GitHub Pages it shares its origin with other sites.
 *
 * The editor's other tabs hold the same databases open, and a database can't be deleted while one does: the reset tells
 * them (a BroadcastChannel), and each lets go — it goes to `?reset=wait`, which opens nothing — and comes back once the
 * reset is done.
 *
 * An instance (shared/instance.ts) resets only itself, and leaves the service worker, which serves everyone; resetting the
 * real editor takes its instances with it.
 */
import { logger } from "@brianjenkins94/util/logger";
import { anyInstance, instance, ownKeys } from "../shared/instance";

const log = logger({ "source": "shell" });

/** The editor's databases: the workspace's, silo's, BABLR's, type acquisition's retired two; VS Code's by prefix. */
const DATABASES = new Set([
	"workspace-fs",
	"silo-local",
	"bablr",
	"ata-cache",
	"vfs-store"
]);
const DATABASE_PREFIX = "vscode-web-";
/** The sign-in's: its database (session.ts) and its keys. */
const SIGN_IN_DATABASE = "editor-session";
const SIGN_IN_KEYS = new Set(["shell:session", "shell:signIn"]);
/** The editor's localStorage keys: the shell's, the panes', the architecture view's, VS Code's, debug-mcp's opt-in. */
const KEY_PREFIXES = [
	"shell:",
	"pane.",
	"architecture.",
	"monaco-"
];
const KEYS = new Set(["debug", "DefaultOverridesCacheExists"]);
/** Where a reset tells the editor's other tabs it's begun and it's done; and the mark it's going on, for a tab that
 *  opens in the middle of it. */
const CHANNEL = instance === undefined ? "editor.reset" : `editor.reset.${instance}`;
const UNDERWAY_KEY = "shell:resetting";

/** Say how a reset goes, in place of the page. */
function say(text: string): void {
	const app = document.getElementById("app");

	if (app !== null) {
		app.textContent = text;
	}
}

/** This address with `reset` (`reset`, `reset=all`, `reset=wait`) in place of any it has, or without one: back to the
 *  editor. The rest of its query as written (URLSearchParams would write `?debug` back as `?debug=`). */
function withReset(reset?: string): string {
	const url = new URL(location.href);
	const kept = url.search.slice(1).split("&").filter((param) => param !== "" && param.split("=")[0] !== "reset");

	url.search = [...kept, ...reset === undefined ? [] : [reset]].join("&");

	return url.href;
}

/** Of an origin's databases and localStorage keys, the editor's: what a reset deletes. Nothing else on the origin. */
export function editorStores(databases: string[], keys: string[], signOut: boolean): { "databases": string[]; "keys": string[] } {
	return {
		"databases": databases.filter((name) => anyInstance(name) || DATABASES.has(name) || name.startsWith(DATABASE_PREFIX) || (signOut && name === SIGN_IN_DATABASE)),
		"keys": keys.filter((key) => (anyInstance(key) || KEYS.has(key) || KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) && (signOut || !SIGN_IN_KEYS.has(key)))
	};
}

/** What the address asks: a reset keeping the sign-in, one signing out too, to wait out another tab's, or none. */
export function resetAsked(): "keep-sign-in" | "all" | "wait" | undefined {
	const asked = new URLSearchParams(location.search).get("reset");

	return asked === null
		? undefined
		: asked === "all" || asked === "wait"
			? asked
			: "keep-sign-in";
}

/** In a tab the editor runs in: when another tab resets it, let go of everything (`?reset=wait`). */
export function followResets(): void {
	new BroadcastChannel(CHANNEL).onmessage = (event: MessageEvent) => {
		if (event.data === "resetting") {
			location.replace(withReset("reset=wait"));
		}
	};
}

/** `?reset=wait`: hold nothing open until the other tab's reset is done, then back to the editor. */
export function waitForReset(): void {
	const channel = new BroadcastChannel(CHANNEL);

	channel.onmessage = (event: MessageEvent) => {
		if (event.data === "done") {
			location.replace(withReset());
		}
	};

	if (localStorage.getItem(UNDERWAY_KEY) === null) {
		location.replace(withReset());
	} else {
		say("The editor is being reset in another tab. This one comes back when that's done.");
	}
}

/** The address that resets the editor and comes back here. */
export function resetAddress(signOut: boolean): string {
	return withReset(signOut ? "reset=all" : "reset");
}

/** Reset, saying how it goes in the page, then load the address without `reset`. `base` is the site's root (where its
 *  service worker is scoped). */
export async function resetEditor(base: string, signOut: boolean): Promise<void> {
	const channel = new BroadcastChannel(CHANNEL);

	say("Resetting the editor…");
	localStorage.setItem(UNDERWAY_KEY, "1");
	channel.postMessage("resetting");

	await log.span("editor.shell.reset.reset", { "signOut": signOut }, async (span) => {
		const scope = new URL(base, location.origin).href;
		// (one serves every instance: only the real editor's reset takes it)
		const workers = instance !== undefined ? [] : (await navigator.serviceWorker?.getRegistrations() ?? []).filter((registration) => registration.scope.startsWith(scope));

		await Promise.all(workers.map(async (registration) => registration.unregister()));

		// (Firefox before 126 can't list them: the editor's own names, then)
		const listed = typeof indexedDB.databases === "function"
			? (await indexedDB.databases()).map((database) => database.name ?? "")
			: [...DATABASES, SIGN_IN_DATABASE];
		const { databases, keys } = editorStores(listed, ownKeys(), signOut);

		for (const name of databases) {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.deleteDatabase(name);

				request.onsuccess = () => {
					resolve();
				};

				request.onerror = () => {
					reject(request.error ?? new Error(`couldn't delete ${name}`));
				};

				// A tab that still has it open, told and not letting go (one from before this reset was built, or hung):
				// deleted once it closes.
				request.onblocked = () => {
					span.warn("database open in another tab", { "database": name });
					say(`Close the editor's other tabs: ${name} is open in one. The reset goes on once it's closed.`);
				};
			});
		}

		for (const key of [...keys, UNDERWAY_KEY]) {
			localStorage.removeItem(key);
		}

		sessionStorage.clear();
		span.end({ "workers": workers.length, "databases": databases.length, "keys": keys.length });
	});

	channel.postMessage("done");
	location.replace(withReset());
}
