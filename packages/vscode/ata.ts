/**
 * Runtime Automatic Type Acquisition — fetch a package's type surface on demand and write it into the workbench
 * filesystem, so an arbitrary `import "pkg"` type-checks with NO bake step (snapshot.ts) and no rebuild.
 *
 * Why it exists (and why it's not the CDN overlay): the type-checker resolves modules against a SYNCHRONOUS view
 * seeded up front (snapshot.ts). The node_modules CDN overlay (node-modules-provider.ts) is async/lazy — great
 * for go-to-definition, but the checker can't await it, which is why baking exists. ATA is the runtime version of
 * the bake: discover a file's imports, fetch their `.d.ts` (+ `@types/<pkg>`, crawling the reference graph), and
 * WRITE the results into the same in-memory FS the seed uses — so the checker resolves them synchronously. The
 * project's manifests add what no import names: package.json's `@types/*`, tsconfig's `types`, and the configs it
 * `extends`. (It replaces TypeScript's own web type acquisition, which installs the whole dependency tree, binaries
 * and all, into the extension host — see settings-defaults.jsonc.)
 *
 * It reuses OUR existing CDN path rather than a third-party acquirer: fetches go same-origin to
 * `<base>/workspace/node_modules/<pkg>/…`, which the service worker proxies to unpkg (with `?meta` for a
 * directory listing and `?v=` to pin a version — see coi-serviceworker.js fetchCdn). Same-origin keeps it clear
 * of the document's COEP, and no `typescript`/@typescript/ata dependency rides along.
 *
 * The crawl resolves references against the package's `?meta` FILE LISTING (so it fetches only files that exist —
 * no blind `.d.ts`/`index.d.ts` probing), pins versions from the workspace's map, and reads the modern `exports`
 * types condition (not just `types`/`typings`) plus each named `exports` subpath's types (`react/jsx-runtime`, which
 * the automatic JSX runtime imports implicitly). When a run adds files, it reloads the TS projects so a resolution
 * that failed before the files landed is retried (see `run`). It writes ONCE, into the workspace filesystem (workspace-fs.ts),
 * and skips anything already present there — which is its cross-reload dedup, since that store persists (so a
 * reload refetches nothing and only genuinely new imports hit the network). No bespoke cache of its own.
 */
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscode from "vscode";

/** Files whose imports are worth acquiring types for. */
const RELEVANT = /\.(?:tsx?|jsx?|mts|cts)$/u;
/** Debounce edits — a re-scan only fetches genuinely new modules, so a short wait coalesces typing. */
const DEBOUNCE_MS = 800;
/** Cap on NETWORK fetches per run (already-present files are free), so a pathological type graph can't runaway. */
const MAX_NETWORK = 400;
/** A declaration file. */
const DECL = /\.d\.[mc]?ts$/u;

/** unpkg `?meta`: a directory node whose `files` recurse (the old listing), or `{ prefix, files }` with every file beneath
 *  it flat, by full path, `type` its MIME type (the current one). */
interface MetaNode { "type"?: string; "path": string; "files"?: MetaNode[] }

/** Bare package specifiers in source (scope-aware), reduced to their package root. Mirrors snapshot.ts. */
function importedPackages(source: string): string[] {
	const roots = new Set<string>();

	for (const match of source.matchAll(/(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/gu)) {
		const pkg = match[1].startsWith("node:") ? "@types/node" : packageRootOf(match[1]);

		if (pkg !== undefined) {
			roots.add(pkg);
		}
	}

	return [...roots];
}

/** JSON with comments and trailing commas (a tsconfig) → its value; undefined when it doesn't parse. */
function parseJsonc(text: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (_, string: string | undefined) => string ?? "").replace(/,(\s*[}\]])/gu, "$1")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** A tsconfig's bare-specifier `extends` (`@tsconfig/node-lts/tsconfig.json`), split into package + file; relative
 *  extends are workspace files, already present. */
function extendsTargets(tsconfig: Record<string, unknown> | undefined): [string, string][] {
	const value = tsconfig?.["extends"];

	return (Array.isArray(value) ? value : [value]).flatMap((spec) => {
		const pkg = typeof spec === "string" ? packageRootOf(spec) : undefined;

		return pkg === undefined ? [] : [[pkg, (spec as string).slice(pkg.length + 1) || "tsconfig.json"] as [string, string]];
	});
}

/** The package root of a bare specifier or node_modules-relative path (scope-aware); undefined for relative/node. */
function packageRootOf(spec: string): string | undefined {
	if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("#")) {
		return undefined; // relative, absolute, a builtin, or a package's own `imports` alias — not a package
	}

	const parts = spec.split("/");
	const pkg = (parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");

	return pkg !== "" && !(pkg.startsWith("@") && !pkg.includes("/")) ? pkg : undefined;
}

/** The DefinitelyTyped counterpart: `react` → `@types/react`, `@scope/name` → `@types/scope__name`. */
function typesCounterpart(pkg: string): string {
	return pkg.startsWith("@") ? "@types/" + pkg.slice(1).replace("/", "__") : "@types/" + pkg;
}

/** The types entry a package declares — classic `types`/`typings`, then the modern `exports["."]` types condition. */
function typesEntry(meta: Record<string, unknown>): string | undefined {
	const classic = meta["types"] ?? meta["typings"];

	if (typeof classic === "string") {
		return classic;
	}

	const exportsField = meta["exports"];

	return pickTypes(typeof exportsField === "string" ? exportsField : (exportsField as Record<string, unknown> | undefined)?.["."]) ?? declarationBeside(meta["main"]);
}

/** The declaration TS looks for beside a JS file, for a package that names only its JS (vite's `exports: { ".":
 *  "./dist/node/index.js" }`): `.js` → `.d.ts`, `.mjs` → `.d.mts`, `.cjs` → `.d.cts`. */
function declarationBeside(js: unknown): string | undefined {
	return typeof js === "string" && (/\.[mc]?js$/u).test(js) ? js.replace(/\.([mc]?)js$/u, ".d.$1ts") : undefined;
}

/** The types entries of a package's named `exports` subpaths (`./jsx-runtime` → its `.d.ts`). TS resolves these
 *  without any textual import — e.g. the automatic JSX runtime implies `react/jsx-runtime` — so they're acquired
 *  up front rather than discovered by crawling. Wildcard patterns are skipped (they'd need a directory walk). */
function subpathTypes(meta: Record<string, unknown>): string[] {
	const exportsField = meta["exports"];

	if (exportsField === null || typeof exportsField !== "object") {
		return [];
	}

	const out: string[] = [];

	for (const [subpath, node] of Object.entries(exportsField as Record<string, unknown>)) {
		if (subpath.startsWith("./") && !subpath.includes("*") && subpath !== "./package.json") {
			const types = pickTypes(node);

			if (types !== undefined) {
				out.push(types);
			}
		}
	}

	return out;
}

/** Pull a `.d.ts` path out of an exports subtree: `{types}`, `{types:{default}}`, or a condition's own `types`. */
function pickTypes(node: unknown): string | undefined {
	if (node === null || typeof node !== "object") {
		return declarationBeside(node); // a string here is the JS entry: its types sit beside it, if anywhere
	}

	const record = node as Record<string, unknown>;
	const types = record["types"];

	if (typeof types === "string") {
		return types;
	}

	if (types !== null && typeof types === "object") {
		const nested = types as Record<string, unknown>;
		const chosen = nested["default"] ?? nested["import"] ?? nested["require"];

		return typeof chosen === "string" ? chosen : undefined;
	}

	for (const condition of ["import", "require", "default"]) {
		const value = record[condition];

		if (value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)["types"] === "string") {
			return (value as Record<string, unknown>)["types"] as string;
		}
	}

	for (const condition of ["import", "require", "default"]) {
		const beside = declarationBeside(record[condition]);

		if (beside !== undefined) {
			return beside;
		}
	}

	return undefined;
}

/** Flatten a `?meta` tree into the set of file paths it contains (package-relative, no leading slash). */
function collectFiles(node: MetaNode, out: Set<string>): void {
	for (const child of node.files ?? []) {
		if (child.type === "directory" || child.files !== undefined) {
			collectFiles(child, out);
		} else {
			out.add(child.path.replace(/^\/+/u, ""));
		}
	}
}

/** Module specifiers + triple-slash references in a `.d.ts` — the graph to crawl: relative paths, other packages, and
 *  `#` aliases from the package's own `imports` map. */
function references(dts: string): { "relative": string[]; "packages": string[]; "imports": string[] } {
	const relative = new Set<string>();
	const packages = new Set<string>();
	const imports = new Set<string>();

	for (const match of dts.matchAll(/(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']|\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']/gu)) {
		const spec = match[1] ?? match[3];
		const kind = match[2]; // "path" | "types" | undefined (a module specifier)

		if (spec === undefined) {
			continue;
		}

		if (kind === "types") {
			packages.add(spec); // /// <reference types="node"> → a package
		} else if (spec.startsWith(".") || kind === "path") {
			relative.add(spec);
		} else if (spec.startsWith("#")) {
			imports.add(spec);
		} else {
			const pkg = packageRootOf(spec);

			if (pkg !== undefined) {
				packages.add(pkg);
			}
		}
	}

	return { "relative": [...relative], "packages": [...packages], "imports": [...imports] };
}

/** A `#` alias through a package's `imports` map (vite's `"#types/*": "./types/*.d.ts"`) → the package-relative path
 *  it names, for resolveInMeta. */
function resolveImport(spec: string, imports: unknown): string | undefined {
	if (imports === null || typeof imports !== "object") {
		return undefined;
	}

	for (const [key, target] of Object.entries(imports as Record<string, unknown>)) {
		const star = key.indexOf("*");
		const [before, after] = star === -1 ? [key, ""] : [key.slice(0, star), key.slice(star + 1)];
		const matches = star === -1 ? spec === key : spec.startsWith(before) && spec.endsWith(after) && spec.length >= key.length - 1;
		const chosen = typeof target === "string" ? target : pickTypes(target);

		if (matches && chosen !== undefined) {
			return chosen.replace("*", spec.slice(before.length, spec.length - after.length));
		}
	}

	return undefined;
}

/** Resolve a relative reference to an EXISTING package file (from `?meta`) — no blind probing, no escaping. */
function resolveInMeta(fromSub: string, ref: string, files: Set<string>): string | undefined {
	const dir = fromSub.includes("/") ? fromSub.slice(0, fromSub.lastIndexOf("/")) : "";
	const joined = new URL(ref, "file:///" + (dir === "" ? "" : dir + "/")).pathname.slice(1); // package-relative, normalized (a root file's base is file:///, not file:////)
	// A `.js` specifier in a declaration means the `.d.ts` beside it (as TS reads it) — the JS itself types nothing.
	const beside = declarationBeside(joined);

	for (const candidate of beside === undefined ? [joined, joined + ".d.ts", joined + ".d.mts", joined + ".d.cts", joined + "/index.d.ts"] : [beside]) {
		if (files.has(candidate)) {
			return candidate;
		}
	}

	return undefined; // not a real file in this package (escaped, or JS-only) — don't chase it
}

/**
 * Wire runtime type acquisition onto the workbench's vscode API. Runs on the active editor now and on every
 * active-editor change / document edit (debounced). `has(absPath)` probes the workspace store (workspace-fs.ts)
 * so a file already present — from the seed, an edit, or a prior session (the store persists) — is never
 * re-fetched. Writes go through `vscode.workspace.fs` into that same store; ATA keeps no cache of its own.
 */
export function installTypeAcquisition(api: typeof vscode, workspaceFolder: string, versions: Record<string, string>, has: (absPath: string) => boolean, log: Logger): void {
	const nodeModules = workspaceFolder.replace(/\/$/u, "") + "/node_modules";
	// Same-origin base the SW intercepts; it proxies /workspace/node_modules/* to the CDN (unversioned → latest).
	const deployBase = location.pathname.slice(0, location.pathname.indexOf("/__vscode__/") + 1) || "/";

	// Drop retired IndexedDB stores from earlier designs (best-effort, one-shot per user):
	//   • "ata-cache"  — ATA's own cache, retired in M1 (the workspace zen-fs store persists now).
	//   • "vfs-store"  — the SW's seed-mirror store, retired once the editor/type-checker/LSP workers all read
	//                    the workspace through the zen-fs FileSystemProvider + shared SharedArrayBuffer.
	try {
		indexedDB.deleteDatabase("ata-cache");
		indexedDB.deleteDatabase("vfs-store");
	} catch { /* best-effort */ }

	const fetchedPath = new Set<string>();          // node_modules-relative paths already handled this session
	const seenPackage = new Set<string>();          // packages already acquired this session
	const metaCache = new Map<string, Set<string>>(); // pkg → its file set (from ?meta)
	const importsOf = new Map<string, unknown>();      // pkg → its package.json `imports` map

	/** Absolute workspace path for a node_modules-relative path. */
	const abs = (rel: string): string => `${nodeModules}/${rel}`;
	// A store written before the crawl could read unpkg's listings holds packages with little more than their entry
	// file, and a stored package is taken to be whole. Until this marker is written, re-crawl what's stored — local
	// reads, plus the listing and any missing file from the network — so one session heals it.
	const HEALED = ".ata-crawl-2";
	const healing = !has(abs(HEALED));
	/** Read a file already in the workspace store as text — no network. */
	const readLocal = async (rel: string): Promise<string | undefined> => {
		try {
			return new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.file(abs(rel))));
		} catch {
			return undefined;
		}
	};

	// Fetch text for a node_modules-relative path (or `?meta` of a package) over the network. Consumes `budget`
	// and pins the package's version when known. Callers skip this entirely for paths already in the store.
	const cdnText = async (rel: string, meta: boolean, budget: { "n": number }): Promise<string | undefined> => {
		if (budget.n <= 0) {
			return undefined;
		}

		budget.n -= 1;

		const version = versions[packageRootOf(rel) ?? rel];
		const search = meta ? "?meta" + (version === undefined ? "" : "&v=" + version) : (version === undefined ? "" : "?v=" + version);

		try {
			const response = await fetch(new URL(`${deployBase}${nodeModules.replace(/^\//u, "")}/${rel}${search}`, location.href).href);

			if (!response.ok) {
				return undefined;
			}

			return await response.text();
		} catch {
			return undefined; // offline / CDN error — acquisition is best-effort
		}
	};

	let written = 0; // files ATA has added to the store this session (see the reload in `run`)

	const write = async (rel: string, code: string): Promise<void> => {
		try {
			await api.workspace.fs.writeFile(api.Uri.file(`${nodeModules}/${rel}`), new TextEncoder().encode(code));
			written += 1;
		} catch { /* already seeded (read-only) or unwritable — the existing copy stands */ }
	};

	const packageFiles = async (pkg: string, budget: { "n": number }): Promise<Set<string>> => {
		const existing = metaCache.get(pkg);

		if (existing !== undefined) {
			return existing;
		}

		const raw = await cdnText(pkg, true, budget);
		const files = new Set<string>();

		if (raw !== undefined) {
			try {
				collectFiles(JSON.parse(raw) as MetaNode, files);
			} catch { /* malformed meta — treated as an empty listing */ }
		}

		metaCache.set(pkg, files);

		return files;
	};

	const acquireFile = async (pkg: string, sub: string, files: Set<string>, budget: { "n": number }): Promise<boolean> => {
		const rel = pkg + "/" + sub;

		if (fetchedPath.has(rel)) {
			return true; // already handled this session
		}

		fetchedPath.add(rel);

		const stored = has(abs(rel));

		if (stored && !healing) {
			return true; // already in the store (seed / persisted / earlier session) — its subtree is too
		}

		const code = stored ? await readLocal(rel) : await cdnText(rel, false, budget);

		if (code === undefined) {
			return false;
		}

		if (!stored) {
			await write(rel, code);
		}

		if (!DECL.test(sub)) {
			return true;
		}

		const { relative, packages, imports } = references(code);
		const targets = [
			...relative.map((ref) => resolveInMeta(sub, ref, files)),
			...imports.map((spec) => resolveImport(spec, importsOf.get(pkg))).filter((path) => path !== undefined).map((path) => resolveInMeta("", path, files))
		];

		// Siblings in parallel: @types/node's index.d.ts alone references ~80 files, one round trip each.
		await Promise.all([
			...targets.filter((target) => target !== undefined).map((target) => acquireFile(pkg, target, files, budget)),
			...packages.map((dep) => acquirePackage(dep, budget))
		]);

		return true;
	};

	async function acquirePackage(pkg: string, budget: { "n": number }): Promise<void> {
		if (seenPackage.has(pkg)) {
			return;
		}

		seenPackage.add(pkg);

		const pkgJsonRel = pkg + "/package.json";
		// Present → acquired in a prior session (the store persists): read package.json LOCALLY, no network, and
		// its whole subtree is already stored (so acquireFile below short-circuits and no ?meta fetch is needed).
		const stored = has(abs(pkgJsonRel));
		const present = stored && !healing;
		const pkgJson = stored ? await readLocal(pkgJsonRel) : await cdnText(pkgJsonRel, false, budget);

		if (pkgJson === undefined) {
			// Not published under this name → try the DefinitelyTyped counterpart (react → @types/react).
			if (!pkg.startsWith("@types/")) {
				await acquirePackage(typesCounterpart(pkg), budget);
			}

			return;
		}

		if (!stored) {
			fetchedPath.add(pkgJsonRel);
			await write(pkgJsonRel, pkgJson);
		}

		let entry: string | undefined;
		let subpaths: string[] = [];

		try {
			const meta = JSON.parse(pkgJson) as Record<string, unknown>;

			entry = typesEntry(meta);
			importsOf.set(pkg, meta["imports"]);
			subpaths = subpathTypes(meta).map((sub) => sub.replace(/^\.\//u, "")).filter((sub) => DECL.test(sub) && sub !== entry?.replace(/^\.\//u, ""));
		} catch { /* malformed package.json */ }

		entry = entry?.replace(/^\.\//u, "");

		// The ?meta listing is only needed to crawl FRESH fetches; a present package's subtree is already stored.
		const files = present ? new Set<string>() : await packageFiles(pkg, budget);

		if (entry === undefined && (present ? has(abs(pkg + "/index.d.ts")) : files.has("index.d.ts"))) {
			entry = "index.d.ts"; // no declared types but a conventional index.d.ts exists
		}

		// A declaration guessed beside a JS entry may not exist: with the listing in hand, don't fetch one that isn't there.
		const listed = (sub: string): boolean => files.size === 0 || files.has(sub);

		if (entry !== undefined && DECL.test(entry) && listed(entry)) {
			await acquireFile(pkg, entry, files, budget);
		} else if (!pkg.startsWith("@types/")) {
			await acquirePackage(typesCounterpart(pkg), budget); // ships no types → DefinitelyTyped counterpart
		}

		for (const sub of subpaths.filter(listed)) {
			await acquireFile(pkg, sub, files, budget);
		}
	}

	/** A tsconfig file another config `extends`, fetched as-is (it's config, not a types entry), with the package.json
	 *  module resolution reads beside it — then whatever IT extends. */
	const acquireConfig = async (pkg: string, sub: string, budget: { "n": number }, depth = 0): Promise<void> => {
		await acquireFile(pkg, "package.json", new Set(), budget);

		if (await acquireFile(pkg, sub, new Set(), budget) && depth < 4) {
			const text = await readLocal(pkg + "/" + sub);

			for (const [next, nextSub] of extendsTargets(text === undefined ? undefined : parseJsonc(text))) {
				await acquireConfig(next, nextSub, budget, depth + 1);
			}
		}
	};

	/** Acquire `packages` (and `configs`, tsconfigs to extend), then reload the TS projects if anything landed. */
	const acquire = (what: Record<string, unknown>, packages: string[], configs: [string, string][] = []): void => {
		const span = log.span("ata", { ...what, "imports": packages.length });
		const budget = { "n": MAX_NETWORK };
		const writtenBefore = written;

		void Promise.all([...packages.map((pkg) => acquirePackage(pkg, budget)), ...configs.map(([pkg, sub]) => acquireConfig(pkg, sub, budget))])
			.then(async () => {
				// tsserver may have resolved these imports (and failed) before the writes landed. Its failed-lookup
				// watchers are registered asynchronously through the extension host, so on a cold boot the writes'
				// change events can arrive before anyone is listening and the failure sticks. Reload the projects
				// (NOT restartTsServer — killing the server mid-open orphans the "Analyzing…" progress) so resolution
				// reruns against files that are now present. Nothing new written → nothing to pick up → no reload.
				const added = written - writtenBefore;

				if (healing && !has(abs(HEALED))) {
					await write(HEALED, "");
				}

				if (added > 0) {
					await api.commands.executeCommand("typescript.reloadProjects");
				}

				span.end({ "files": fetchedPath.size, "network": MAX_NETWORK - budget.n, "added": added });
			})
			.catch((error: unknown) => { span.error("ata failed", { "error": error instanceof Error ? error.message : String(error) }); span.end(); });
	};

	const run = (document: vscode.TextDocument | undefined): void => {
		if (document === undefined || document.uri.scheme !== "file" || !RELEVANT.test(document.uri.path) || document.uri.path.includes("/node_modules/")) {
			return;
		}

		const packages = importedPackages(document.getText());

		if (packages.length > 0) {
			acquire({ "file": document.uri.path }, packages);
		}
	};

	// What the PROJECT needs that no source file imports: the root package.json's `@types/*` dependencies (the ambient
	// `process` of @types/node), tsconfig's `compilerOptions.types`, and the configs a tsconfig `extends`.
	const runProject = async (): Promise<void> => {
		const root = workspaceFolder.replace(/\/$/u, "");
		const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
			try {
				return parseJsonc(new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.file(root + "/" + path))));
			} catch {
				return undefined;
			}
		};

		const [manifest, tsconfig] = await Promise.all([read("package.json"), read("tsconfig.json")]);
		const declared = Object.keys({ ...manifest?.["dependencies"] as object, ...manifest?.["devDependencies"] as object }).filter((name) => name.startsWith("@types/"));
		const types = (tsconfig?.["compilerOptions"] as { "types"?: unknown } | undefined)?.types;
		const listed = Array.isArray(types) ? types.filter((name): name is string => typeof name === "string").map((name) => packageRootOf(name) ?? name) : [];
		const packages = [...new Set([...declared, ...listed])];
		const configs = extendsTargets(tsconfig);

		// Apart, so the few config files land (and reload the project) without waiting on a big types crawl.
		if (configs.length > 0) {
			acquire({ "file": root + "/tsconfig.json" }, [], configs);
		}

		if (packages.length > 0) {
			acquire({ "file": root + "/{package.json,tsconfig.json}" }, packages);
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	let projectTimer: ReturnType<typeof setTimeout> | undefined;
	// A repo load replaces both manifests: re-read them once it settles.
	const manifests = api.workspace.createFileSystemWatcher(new api.RelativePattern(api.Uri.file(workspaceFolder), "{package.json,tsconfig.json}"));
	const scheduleProject = (): void => {
		clearTimeout(projectTimer);
		projectTimer = setTimeout(() => {
			void runProject();
		}, DEBOUNCE_MS);
	};

	manifests.onDidCreate(scheduleProject);
	manifests.onDidChange(scheduleProject);
	void runProject();

	const schedule = (document: vscode.TextDocument | undefined): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(run, DEBOUNCE_MS, document);
	};

	api.window.onDidChangeActiveTextEditor((editor) => { schedule(editor?.document); });
	api.workspace.onDidChangeTextDocument((event) => { schedule(event.document); });
	run(api.window.activeTextEditor?.document); // acquire for whatever's already open
}
