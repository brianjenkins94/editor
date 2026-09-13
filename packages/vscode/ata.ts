/**
 * Runtime Automatic Type Acquisition — fetch a package's type surface on demand and write it into the workbench
 * filesystem, so an arbitrary `import "pkg"` type-checks with NO bake step (snapshot.ts) and no rebuild.
 *
 * Why it exists (and why it's not the CDN overlay): the type-checker resolves modules against a SYNCHRONOUS view
 * seeded up front (snapshot.ts). The node_modules CDN overlay (node-modules-provider.ts) is async/lazy — great
 * for go-to-definition, but the checker can't await it, which is why baking exists. ATA is the runtime version of
 * the bake: discover a file's imports, fetch their `.d.ts` (+ `@types/<pkg>`, crawling the reference graph), and
 * WRITE the results into the same in-memory FS the seed uses — so the checker resolves them synchronously.
 *
 * It reuses OUR existing CDN path rather than a third-party acquirer: fetches go same-origin to
 * `<base>/workspace/node_modules/<pkg>/…`, which the service worker proxies to unpkg (with `?meta` for a
 * directory listing and `?v=` to pin a version — see coi-serviceworker.js fetchCdn). Same-origin keeps it clear
 * of the document's COEP, and no `typescript`/@typescript/ata dependency rides along.
 *
 * The crawl resolves references against the package's `?meta` FILE LISTING (so it fetches only files that exist —
 * no blind `.d.ts`/`index.d.ts` probing), pins versions from the workspace's map, and reads the modern `exports`
 * types condition (not just `types`/`typings`). It writes ONCE, into the workspace filesystem (workspace-fs.ts),
 * and skips anything already present there — which is its cross-reload dedup, since that store persists (so a
 * reload refetches nothing and only genuinely new imports hit the network). No bespoke cache of its own.
 */
import type * as vscode from "vscode";
import type { Logger } from "@brianjenkins94/util/logger";

/** Files whose imports are worth acquiring types for. */
const RELEVANT = /\.(?:tsx?|jsx?|mts|cts)$/u;
/** Debounce edits — a re-scan only fetches genuinely new modules, so a short wait coalesces typing. */
const DEBOUNCE_MS = 800;
/** Cap on NETWORK fetches per run (already-present files are free), so a pathological type graph can't runaway. */
const MAX_NETWORK = 400;
/** A declaration file. */
const DECL = /\.d\.[mc]?ts$/u;

/** unpkg `?meta` directory node: a file, or a directory whose `files` recurse. */
interface MetaNode { "type": "file" | "directory"; "path": string; "files"?: MetaNode[] }

/** Bare package specifiers in source (scope-aware), reduced to their package root. Mirrors snapshot.ts. */
function importedPackages(source: string): string[] {
	const roots = new Set<string>();

	for (const match of source.matchAll(/(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/gu)) {
		const pkg = packageRootOf(match[1]);

		if (pkg !== undefined) {
			roots.add(pkg);
		}
	}

	return [...roots];
}

/** The package root of a bare specifier or node_modules-relative path (scope-aware); undefined for relative/node. */
function packageRootOf(spec: string): string | undefined {
	if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
		return undefined;
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

	return pickTypes((meta["exports"] as Record<string, unknown> | undefined)?.["."]);
}

/** Pull a `.d.ts` path out of an exports subtree: `{types}`, `{types:{default}}`, or a condition's own `types`. */
function pickTypes(node: unknown): string | undefined {
	if (node === null || typeof node !== "object") {
		return undefined; // a string here is the JS entry, not types
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

	return undefined;
}

/** Flatten a `?meta` tree into the set of file paths it contains (package-relative, no leading slash). */
function collectFiles(node: MetaNode, out: Set<string>): void {
	for (const child of node.files ?? []) {
		if (child.type === "file") {
			out.add(child.path.replace(/^\/+/u, ""));
		} else {
			collectFiles(child, out);
		}
	}
}

/** Module specifiers + triple-slash references in a `.d.ts` — the graph to crawl. */
function references(dts: string): { "relative": string[]; "packages": string[] } {
	const relative = new Set<string>();
	const packages = new Set<string>();

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
		} else {
			const pkg = packageRootOf(spec);

			if (pkg !== undefined) {
				packages.add(pkg);
			}
		}
	}

	return { "relative": [...relative], "packages": [...packages] };
}

/** Resolve a relative reference to an EXISTING package file (from `?meta`) — no blind probing, no escaping. */
function resolveInMeta(fromSub: string, ref: string, files: Set<string>): string | undefined {
	const dir = fromSub.includes("/") ? fromSub.slice(0, fromSub.lastIndexOf("/")) : "";
	const joined = new URL(ref, "file:///" + dir + "/").pathname.slice(1); // package-relative, normalized

	for (const candidate of [joined, joined + ".d.ts", joined + ".d.mts", joined + ".d.cts", joined + "/index.d.ts"]) {
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

	try {
		indexedDB.deleteDatabase("ata-cache"); // retired in M1 — the workspace store persists now; drop the old cache
	} catch { /* best-effort */ }

	const fetchedPath = new Set<string>();          // node_modules-relative paths already handled this session
	const seenPackage = new Set<string>();          // packages already acquired this session
	const metaCache = new Map<string, Set<string>>(); // pkg → its file set (from ?meta)

	/** Absolute workspace path for a node_modules-relative path. */
	const abs = (rel: string): string => `${nodeModules}/${rel}`;
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

	const write = async (rel: string, code: string): Promise<void> => {
		try {
			await api.workspace.fs.writeFile(api.Uri.file(`${nodeModules}/${rel}`), new TextEncoder().encode(code));
		} catch { /* already seeded (read-only) or unwritable — the existing copy stands */ }
	};

	// The in-browser tsserver doesn't scan @types typeRoots (see snapshot.ts), so a written @types package resolves
	// ONLY when a root .d.ts force-references it. We keep our own such file, rewritten as @types are acquired — the
	// runtime twin of snapshot.ts's editor-ambient.d.ts.
	const acquiredTypes = new Set<string>();

	const writeAmbient = async (): Promise<void> => {
		const refs = [...acquiredTypes].sort().map((pkg) => `/// <reference path="./node_modules/${pkg}/index.d.ts" />`).join("\n");

		try {
			await api.workspace.fs.writeFile(
				api.Uri.file(`${workspaceFolder.replace(/\/$/u, "")}/ata-ambient.d.ts`),
				new TextEncoder().encode("// Auto-generated by ata.ts — force-references acquired @types packages (typeRoots aren't scanned).\n" + refs + "\n")
			);
		} catch { /* unwritable — acquired @types just won't resolve until next attempt */ }
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

		if (has(abs(rel))) {
			return true; // already in the store (seed / persisted / earlier session) — its subtree is too
		}

		const code = await cdnText(rel, false, budget);

		if (code === undefined) {
			return false;
		}

		await write(rel, code);

		if (!DECL.test(sub)) {
			return true;
		}

		const { relative, packages } = references(code);

		for (const ref of relative) {
			const target = resolveInMeta(sub, ref, files);

			if (target !== undefined) {
				await acquireFile(pkg, target, files, budget);
			}
		}

		for (const dep of packages) {
			await acquirePackage(dep, budget);
		}

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
		const present = has(abs(pkgJsonRel));
		const pkgJson = present ? await readLocal(pkgJsonRel) : await cdnText(pkgJsonRel, false, budget);

		if (pkgJson === undefined) {
			// Not published under this name → try the DefinitelyTyped counterpart (react → @types/react).
			if (!pkg.startsWith("@types/")) {
				await acquirePackage(typesCounterpart(pkg), budget);
			}

			return;
		}

		if (!present) {
			fetchedPath.add(pkgJsonRel);
			await write(pkgJsonRel, pkgJson);
		}

		let entry: string | undefined;

		try {
			entry = typesEntry(JSON.parse(pkgJson) as Record<string, unknown>);
		} catch { /* malformed package.json */ }

		entry = entry?.replace(/^\.\//u, "");

		// The ?meta listing is only needed to crawl FRESH fetches; a present package's subtree is already stored.
		const files = present ? new Set<string>() : await packageFiles(pkg, budget);

		if (entry === undefined && (present ? has(abs(pkg + "/index.d.ts")) : files.has("index.d.ts"))) {
			entry = "index.d.ts"; // no declared types but a conventional index.d.ts exists
		}

		if (entry !== undefined && DECL.test(entry)) {
			const wrote = await acquireFile(pkg, entry, files, budget);

			// A resolved @types package needs a root force-reference (typeRoots aren't scanned) — record it.
			if (wrote && pkg.startsWith("@types/") && entry === "index.d.ts") {
				acquiredTypes.add(pkg);
			}
		} else if (!pkg.startsWith("@types/")) {
			await acquirePackage(typesCounterpart(pkg), budget); // ships no types → DefinitelyTyped counterpart
		}
	}

	const run = (document: vscode.TextDocument | undefined): void => {
		if (document === undefined || document.uri.scheme !== "file" || !RELEVANT.test(document.uri.path) || document.uri.path.includes("/node_modules/")) {
			return;
		}

		const packages = importedPackages(document.getText());

		if (packages.length === 0) {
			return;
		}

		const span = log.span("ata", { "file": document.uri.path, "imports": packages.length });
		const budget = { "n": MAX_NETWORK };
		const typesBefore = acquiredTypes.size;

		void Promise.all(packages.map((pkg) => acquirePackage(pkg, budget)))
			.then(async () => {
				if (acquiredTypes.size !== typesBefore) {
					await writeAmbient(); // new @types acquired → refresh the force-reference file so they resolve
				}

				span.end({ "files": fetchedPath.size, "network": MAX_NETWORK - budget.n, "types": acquiredTypes.size });
			})
			.catch((error: unknown) => { span.error("ata failed", { "error": error instanceof Error ? error.message : String(error) }); span.end(); });
	};

	let timer: ReturnType<typeof setTimeout> | undefined;

	const schedule = (document: vscode.TextDocument | undefined): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => run(document), DEBOUNCE_MS);
	};

	api.window.onDidChangeActiveTextEditor((editor) => schedule(editor?.document));
	api.workspace.onDidChangeTextDocument((event) => schedule(event.document));
	run(api.window.activeTextEditor?.document); // acquire for whatever's already open
}
