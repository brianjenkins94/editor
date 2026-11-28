const PREFIX = "instance:";

export const instanced = (instance: string, name: string): string => `${PREFIX}${instance}:${name}`;

export const ownName = (instance: string, name: string): string | undefined => (name.startsWith(instanced(instance, "")) ? name.slice(instanced(instance, "").length) : undefined);

export const anyInstance = (name: string): boolean => name.startsWith(PREFIX);

function named(): string | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}

	try {
		for (let frame: Window = window; ; frame = frame.parent) {
			const name = new URLSearchParams(frame.location.search).get("instance") ?? signingInto(frame);

			if (name !== null && name !== "" && name !== undefined) {
				return name;
			}

			if (frame.parent === frame) {
				return undefined;
			}
		}
	} catch {
		return undefined;
	}
}

function signingInto(frame: Window): string | undefined {
	try {
		const state = new URLSearchParams(frame.location.search).get("state");

		for (const key of state === null ? [] : Object.keys(sessionStorage)) {
			const owner = /^instance:(.+):shell:signIn$/u.exec(key)?.[1];

			if (owner !== undefined && (JSON.parse(sessionStorage.getItem(key) ?? "{}") as { "state"?: string }).state === state) {
				return owner;
			}
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export const instance = named();

const landing = typeof window === "undefined" ? undefined : signingInto(window);

export function isEditorTop(): boolean {
	return window.parent === window || new URLSearchParams(location.search).get("instance") !== null || landing !== undefined;
}

export function ownKeys(): string[] {
	const keys = Object.keys(localStorage);

	return instance === undefined ? keys : keys.flatMap((key) => ownName(instance, key) ?? []);
}

export function seedFiles(search: string): Record<string, string> | undefined {
	const seed = new URLSearchParams(search).get("seed");

	if (instance === undefined || seed === null) {
		return undefined;
	}

	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(seed), (character) => character.codePointAt(0)!))) as Record<string, string>;
}

export function isolate(name: string, factory: Pick<IDBFactory, "open" | "deleteDatabase" | "databases">, storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">, entries: (store: Storage) => string[]): void {
	const { open, deleteDatabase, databases } = factory;
	const { getItem, setItem, removeItem } = storage;

	factory.open = function(database: string, version?: number): IDBOpenDBRequest {
		return open.call(this, instanced(name, database), version);
	};
	factory.deleteDatabase = function(database: string): IDBOpenDBRequest {
		return deleteDatabase.call(this, instanced(name, database));
	};
	factory.databases = async function(): Promise<IDBDatabaseInfo[]> {
		return (await databases.call(this)).flatMap((info) => {
			const own = info.name === undefined ? undefined : ownName(name, info.name);

			return own === undefined ? [] : [{ ...info, "name": own }];
		});
	};
	storage.getItem = function(this: Storage, key: string): string | null {
		return getItem.call(this, instanced(name, key));
	};
	storage.setItem = function(this: Storage, key: string, value: string): void {
		setItem.call(this, instanced(name, key), value);
	};
	storage.removeItem = function(this: Storage, key: string): void {
		removeItem.call(this, instanced(name, key));
	};
	storage.clear = function(this: Storage): void {
		for (const key of entries(this)) {
			if (ownName(name, key) !== undefined) {
				removeItem.call(this, key);
			}
		}
	};
}

export function isolateDatabaseNames(name: string, database: { "prototype": IDBDatabase }): void {
	const stored = Object.getOwnPropertyDescriptor(database.prototype, "name")!.get!;

	Object.defineProperty(database.prototype, "name", {
		"configurable": true,
		"get": function(this: IDBDatabase): string {
			const own = stored.call(this) as string;

			return ownName(name, own) ?? own;
		}
	});
}

if (instance !== undefined) {
	isolate(instance, IDBFactory.prototype, Storage.prototype, (store) => Object.keys(store));
	isolateDatabaseNames(instance, IDBDatabase);
}
