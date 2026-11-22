import type { createRpcClient, Hub } from "@brianjenkins94/hub";
import type { FunctionComponent } from "preact";
import type { RepoBinding } from "./github-auth";
import { logger } from "@brianjenkins94/util/logger";
import { useEffect, useState } from "preact/hooks";

export interface ShellContext {
	"hub": Hub;
	"rpc": ReturnType<typeof createRpcClient>;
}

export interface ShellFeature {
	"start"?: (shell: ShellContext) => void;
	"control"?: { "place": "start" | "end"; "Control": FunctionComponent<{ "shell": ShellContext }> };
	"Overlay"?: FunctionComponent<{ "shell": ShellContext }>;
}

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

export function useStore<T>(store: Store<T>): T {
	const [, setChanges] = useState(0);

	useEffect(() => store.subscribe(() => {
		setChanges((changes) => changes + 1);
	}), [store]);

	return store.get();
}

export const shared = createStore<{ "signedInAs"?: string; "githubUser"?: string; "boundRepo"?: RepoBinding; "githubOpen": boolean }>({ "githubOpen": false });

export const githubLog = logger({ "source": "github" });

export function errText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	const thrown = error as string | number | boolean | null | undefined;

	return String(thrown);
}

export const statusOf = (error: unknown): number | undefined => (typeof (error as { "status"?: unknown }).status === "number" ? (error as { "status": number }).status : undefined);
