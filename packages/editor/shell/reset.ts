import { logger } from "@brianjenkins94/util/logger";
import { anyInstance, instance, ownKeys } from "../shared/instance";

const log = logger({ "source": "shell" });

const DATABASES = new Set([
	"workspace-fs",
	"silo-local",
	"bablr",
	"ata-cache",
	"vfs-store"
]);
const DATABASE_PREFIX = "vscode-web-";
const SIGN_IN_DATABASE = "editor-session";
const SIGN_IN_KEYS = new Set(["shell:session", "shell:signIn"]);
const KEY_PREFIXES = [
	"shell:",
	"pane.",
	"architecture.",
	"monaco-"
];
const KEYS = new Set(["debug", "DefaultOverridesCacheExists"]);
const CHANNEL = instance === undefined ? "editor.reset" : `editor.reset.${instance}`;
const UNDERWAY_KEY = "shell:resetting";

function say(text: string): void {
	const app = document.getElementById("app");

	if (app !== null) {
		app.textContent = text;
	}
}

function withReset(reset?: string): string {
	const url = new URL(location.href);
	const kept = url.search.slice(1).split("&").filter((param) => param !== "" && param.split("=")[0] !== "reset");

	url.search = [...kept, ...reset === undefined ? [] : [reset]].join("&");

	return url.href;
}

export function editorStores(databases: string[], keys: string[], signOut: boolean): { "databases": string[]; "keys": string[] } {
	return {
		"databases": databases.filter((name) => anyInstance(name) || DATABASES.has(name) || name.startsWith(DATABASE_PREFIX) || (signOut && name === SIGN_IN_DATABASE)),
		"keys": keys.filter((key) => (anyInstance(key) || KEYS.has(key) || KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) && (signOut || !SIGN_IN_KEYS.has(key)))
	};
}

export function resetAsked(): "keep-sign-in" | "all" | "wait" | undefined {
	const asked = new URLSearchParams(location.search).get("reset");

	return asked === null
		? undefined
		: asked === "all" || asked === "wait"
			? asked
			: "keep-sign-in";
}

export function followResets(): void {
	new BroadcastChannel(CHANNEL).onmessage = (event: MessageEvent) => {
		if (event.data === "resetting") {
			location.replace(withReset("reset=wait"));
		}
	};
}

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

export function resetAddress(signOut: boolean): string {
	return withReset(signOut ? "reset=all" : "reset");
}

export async function resetEditor(base: string, signOut: boolean): Promise<void> {
	const channel = new BroadcastChannel(CHANNEL);

	say("Resetting the editor…");
	localStorage.setItem(UNDERWAY_KEY, "1");
	channel.postMessage("resetting");

	await log.span("editor.shell.reset.reset", { "signOut": signOut }, async (span) => {
		const scope = new URL(base, location.origin).href;
		const workers = instance !== undefined ? [] : (await navigator.serviceWorker?.getRegistrations() ?? []).filter((registration) => registration.scope.startsWith(scope));

		await Promise.all(workers.map(async (registration) => registration.unregister()));

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
