/**
 * A stand-in for the `vscode` module, for an extension's wiring tested in Node: `activate` run against it, its commands
 * called, what it registered read back. It has what the extensions tested here use of VS Code's API and nothing more —
 * it grows as a test needs more. Tests reach it through `fake` (the registrations, the watchers, the answers given to the
 * commands the editor's core would answer); `import "./vscode/hooks.mjs"` first makes `import * as vscode from
 * "vscode"` resolve here. Tests inside the editor's real extension host are for later (NEXT.md, *Parked*).
 */

type Listener<T> = (value: T) => unknown;

export class Disposable {
	private readonly done: () => void;

	public constructor(done: () => void) {
		this.done = done;
	}

	public dispose(): void {
		this.done();
	}
}

export class EventEmitter<T> {
	private readonly listeners = new Set<Listener<T>>();

	public readonly event = (listener: Listener<T>): Disposable => {
		this.listeners.add(listener);

		return new Disposable(() => {
			this.listeners.delete(listener);
		});
	};

	public fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}

	public dispose(): void {
		this.listeners.clear();
	}
}

export class Uri {
	public readonly scheme: string;
	public readonly path: string;

	private constructor(scheme: string, path: string) {
		this.scheme = scheme;
		this.path = path;
	}

	public static file(path: string): Uri {
		return new Uri("file", path);
	}

	public static parse(value: string): Uri {
		const [, scheme = "file", path = value] = /^([a-z][\w+.-]*):\/\/(.*)$/u.exec(value) ?? [];

		return new Uri(scheme, path);
	}

	public static joinPath(base: Uri, ...parts: string[]): Uri {
		return new Uri(base.scheme, [base.path.replace(/\/$/u, ""), ...parts].join("/"));
	}

	public toString(): string {
		return `${this.scheme}://${this.path}`;
	}
}

export class ThemeColor {
	public readonly id: string;

	public constructor(id: string) {
		this.id = id;
	}
}

interface FileDecoration { "badge"?: string; "tooltip"?: string; "color"?: ThemeColor }
interface FileDecorationProvider { "onDidChangeFileDecorations"?: (listener: Listener<Uri | Uri[] | undefined>) => Disposable; "provideFileDecoration": (uri: Uri) => FileDecoration | undefined }

/** A watcher's three events, each firable by a test (`fake.change(path)`). */
class Watcher {
	public readonly changed = new EventEmitter<Uri>();
	public readonly created = new EventEmitter<Uri>();
	public readonly deleted = new EventEmitter<Uri>();
	public readonly onDidChange = this.changed.event;
	public readonly onDidCreate = this.created.event;
	public readonly onDidDelete = this.deleted.event;

	public dispose(): void {
		fake.watchers.delete(this);
	}
}

const ROOT = Uri.file("/workspace");
const saved = new EventEmitter<{ "uri": Uri }>();

/** What the extension registered, and what a test answers for the editor's core. */
export const fake = {
	"commands": new Map<string, (...args: unknown[]) => unknown>(),
	"decorations": [] as FileDecorationProvider[],
	"watchers": new Set<Watcher>(),
	/** A file changed on disk, as a watcher sees it. */
	"change": (path: string): void => {
		for (const watcher of fake.watchers) {
			watcher.changed.fire(Uri.joinPath(ROOT, path));
		}
	},
	/** A document saved. */
	"save": (path: string): void => {
		saved.fire({ "uri": Uri.joinPath(ROOT, path) });
	},
	/** The decoration a file has now, from every provider registered. */
	"decorationOf": (path: string): FileDecoration | undefined => fake.decorations.map((provider) => provider.provideFileDecoration(Uri.joinPath(ROOT, path))).find((decoration) => decoration !== undefined),
	"reset": (): void => {
		fake.commands.clear();
		fake.decorations.length = 0;
		fake.watchers.clear();
	}
};

export const commands = {
	"registerCommand": (id: string, run: (...args: unknown[]) => unknown): Disposable => {
		fake.commands.set(id, run);

		return new Disposable(() => {
			fake.commands.delete(id);
		});
	},
	"executeCommand": async <T>(id: string, ...args: unknown[]): Promise<T> => {
		const run = fake.commands.get(id);

		if (run === undefined) {
			throw new Error(`command '${id}' not found`);
		}

		return await run(...args) as T;
	}
};

export const window = {
	"registerFileDecorationProvider": (provider: FileDecorationProvider): Disposable => {
		fake.decorations.push(provider);

		return new Disposable(() => {
			fake.decorations.splice(fake.decorations.indexOf(provider), 1);
		});
	}
};

export const workspace = {
	"workspaceFolders": [{ "uri": ROOT, "name": "workspace", "index": 0 }],
	"createFileSystemWatcher": (_glob: string): Watcher => {
		const watcher = new Watcher();

		fake.watchers.add(watcher);

		return watcher;
	},
	"onDidSaveTextDocument": saved.event,
	"asRelativePath": (uri: Uri | string): string => (typeof uri === "string" ? uri : uri.path).replace(/^\/workspace\//u, "")
};
