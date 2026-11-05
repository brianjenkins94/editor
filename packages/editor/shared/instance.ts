/**
 * An instance of the editor, kept apart from another on the same origin: `?instance=<name>`, so an editor run inside an
 * editor's preview window (which is how the editor's own tests come to run in the editor) has its own workspace, its own
 * VS Code state and its own settings, and nothing it does reaches the real ones. Same origin means the same IndexedDB and
 * localStorage, and VS Code names its databases itself, so this works underneath everything: in each realm on the page's
 * thread, imported first, IndexedDB's and Storage's methods are wrapped to add the instance to every name.
 *
 * A frame with the name in its own address is that instance's top: it renders the shell, whatever frame it's in. The
 * frames under it find the name by looking up. Workers aren't covered: the only database one opens is BABLR's cache of
 * parses, kept by the text's own hash, which instances can safely share. The one service worker serves them all, each by
 * its tab. Without a name, nothing here does anything.
 */

const PREFIX = "instance:";

/** A name as an instance `instance` keeps it. */
export const instanced = (instance: string, name: string): string => `${PREFIX}${instance}:${name}`;

/** What an instance's name says it is, or undefined when it's another's, or nobody's. */
export const ownName = (instance: string, name: string): string | undefined => (name.startsWith(instanced(instance, "")) ? name.slice(instanced(instance, "").length) : undefined);

/** Whether a database or key is any instance's: what a reset of the real one takes with it. */
export const anyInstance = (name: string): boolean => name.startsWith(PREFIX);

/** The instance named in this frame's address or the nearest frame above with one; none: the real editor. */
function named(): string | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}

	try {
		for (let frame: Window = window; ; frame = frame.parent) {
			const name = new URLSearchParams(frame.location.search).get("instance");

			if (name !== null && name !== "") {
				return name;
			}

			if (frame.parent === frame) {
				return undefined;
			}
		}
	} catch {
		// (a cross-origin frame above: nothing above it is ours)
		return undefined;
	}
}

export const instance = named();

/** Whether this frame is the top of an editor: the window's own, or an instance named in its own address. */
export function isEditorTop(): boolean {
	return window.parent === window || new URLSearchParams(location.search).get("instance") !== null;
}

/** This instance's localStorage keys, as it names them: `Object.keys(localStorage)` shows the origin's. */
export function ownKeys(): string[] {
	const keys = Object.keys(localStorage);

	return instance === undefined ? keys : keys.flatMap((key) => ownName(instance, key) ?? []);
}

/** The files an instance starts with, in its address (`&seed=`: base64 of JSON, each path from the workspace's root, with its
 *  text), in place of the starter: what a test sets up, with nothing crossing from another instance. Only an instance has
 *  them, and what it keeps is written over them. */
export function seedFiles(search: string): Record<string, string> | undefined {
	const seed = new URLSearchParams(search).get("seed");

	if (instance === undefined || seed === null) {
		return undefined;
	}

	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(seed), (character) => character.codePointAt(0)!))) as Record<string, string>;
}

/** IndexedDB and Storage, from here on, as `name`'s only. */
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

/** A database's `name`, from here on, as `name` asked for it, not as it's stored: zen-fs opens its object store by it. */
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
