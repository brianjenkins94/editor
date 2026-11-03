/**
 * The shell's extension point: each feature of the top window is a module that registers what it adds — something to
 * start once the shell's hub is linked to the app (serves, subscriptions, what a page load finishes), a control in the
 * top bar, and anything it draws over the page — and the shell (shell.tsx) is the layout they're placed in. A feature
 * comes back by adding its module to the shell's list; nothing else of the shell changes.
 *
 * And what the features share: who's signed in, the repository the workspace is a clone of, and whether the GitHub
 * popover is open — each a small store a feature reads with `useStore` and sets from anywhere.
 */
import type { createRpcClient, Hub } from "@brianjenkins94/hub";
import type { FunctionComponent } from "preact";
import type { RepoBinding } from "./github-auth";
import { logger } from "@brianjenkins94/util/logger";
import { useEffect, useState } from "preact/hooks";

/** What a feature is given: the shell's hub, linked to the app, and a client for asking over it. */
export interface ShellContext {
	"hub": Hub;
	"rpc": ReturnType<typeof createRpcClient>;
}

export interface ShellFeature {
	/** Started once, when the shell's hub is linked to the app. */
	"start"?: (shell: ShellContext) => void;
	/** Its control in the top bar: with the workspace's (`start`, before the spacer) or with the editor's (`end`). */
	"control"?: { "place": "start" | "end"; "Control": FunctionComponent<{ "shell": ShellContext }> };
	/** What it draws over the page: a dialog, a notice. */
	"Overlay"?: FunctionComponent<{ "shell": ShellContext }>;
}

/** A value features share: read, set (a patch, or from what it is), and listened to. */
export interface Store<T> {
	"get": () => T;
	"set": (patch: Partial<T> | ((now: T) => Partial<T>)) => void;
	"subscribe": (listener: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
	let value = initial;
	const listeners = new Set<() => void>();

	return {
		"get": () => value,
		"set": (patch) => {
			value = { ...value, ...typeof patch === "function" ? patch(value) : patch };

			for (const listener of [...listeners]) {
				listener();
			}
		},
		"subscribe": (listener) => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		}
	};
}

/** A store's value, rendered again as it changes. */
export function useStore<T>(store: Store<T>): T {
	const [, setChanges] = useState(0);

	useEffect(() => store.subscribe(() => {
		setChanges((changes) => changes + 1);
	}), [store]);

	return store.get();
}

/** What the shell's features share. Signing in is optional: `signedInAs` says who (GitHub's login, or the account's
 *  email; undefined = signed out); `githubUser` is GitHub's login when the sign-in is GitHub's (fetched live through the
 *  API's proxy), what private repos and commits need. `boundRepo` is the repository the workspace is a clone of (where a
 *  commit pushes): the workspace's own origin, asked once the workbench answers (`git.origin`), and set again by each
 *  load. `githubOpen`: the GitHub popover, which a sign-in that failed or a load from the address opens. */
export const shared = createStore<{ "signedInAs"?: string; "githubUser"?: string; "boundRepo"?: RepoBinding; "githubOpen": boolean }>({ "githubOpen": false });

// The GitHub data plane's logger — spans + records federate to the `$sys.log.>` observability plane (debug-mcp).
// The shell owns the token and the network calls, so this is where load/commit/connect are traced.
export const githubLog = logger({ "source": "github" });

export function errText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	// What isn't an Error is stringified as it is (a thrown string, if anything else).
	const thrown = error as string | number | boolean | null | undefined;

	return String(thrown);
}

export const statusOf = (error: unknown): number | undefined => (typeof (error as { "status"?: unknown }).status === "number" ? (error as { "status": number }).status : undefined);
