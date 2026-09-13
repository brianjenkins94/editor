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
 * `<base>/workspace/node_modules/<pkg>/…`, which the service worker proxies to unpkg (following the unversioned
 * 302 to latest — see coi-serviceworker.js fetchCdn). Same-origin keeps it clear of the document's COEP, and no
 * `typescript`/@typescript/ata dependency rides along — discovery is a lightweight scan, matching snapshot.ts.
 *
 * Best-effort: it handles the common shapes (a package's own `types`/`typings`/`exports["."].types`, its
 * DefinitelyTyped `@types/<pkg>` counterpart, and relative `.d.ts` + triple-slash references). Exotic
 * conditional-exports-only type maps may not fully resolve; the bake seed still covers the curated demo deps.
 */
import type * as vscode from "vscode";
import type { Logger } from "@brianjenkins94/util/logger";

/** Files whose imports are worth acquiring types for. */
const RELEVANT = /\.(?:tsx?|jsx?|mts|cts)$/u;
/** Debounce edits — a re-scan only fetches genuinely new modules, so a short wait coalesces typing. */
const DEBOUNCE_MS = 800;
/** Safety cap on fetches per acquisition run, so a pathological type graph can't runaway. */
const MAX_FETCHES = 500;

/** Bare package specifiers in source (scope-aware), reduced to their package root. Mirrors snapshot.ts. */
function importedPackages(source: string): string[] {
	const roots = new Set<string>();

	for (const match of source.matchAll(/(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/gu)) {
		const spec = match[1];

		if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
			continue;
		}

		const parts = spec.split("/");
		const pkg = (parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");

		if (pkg !== "" && !(pkg.startsWith("@") && !pkg.includes("/"))) {
			roots.add(pkg);
		}
	}

	return [...roots];
}

/** The DefinitelyTyped counterpart: `react` → `@types/react`, `@scope/name` → `@types/scope__name`. */
function typesCounterpart(pkg: string): string {
	return pkg.startsWith("@") ? "@types/" + pkg.slice(1).replace("/", "__") : "@types/" + pkg;
}

/** The types entry a package declares (classic fields first, then a simple exports["."] types condition). */
function typesEntry(meta: Record<string, unknown>): string | undefined {
	const classic = meta["types"] ?? meta["typings"];

	if (typeof classic === "string") {
		return classic;
	}

	const root = (meta["exports"] as Record<string, unknown> | undefined)?.["."];
	const types = typeof root === "object" && root !== null ? (root as Record<string, unknown>)["types"] : undefined;

	return typeof types === "string" ? types : (typeof types === "object" && types !== null ? (types as Record<string, unknown>)["default"] as string | undefined : undefined);
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
		} else if (spec.startsWith(".") || spec.startsWith("/") || kind === "path") {
			relative.add(spec);
		} else if (!spec.startsWith("node:")) {
			const parts = spec.split("/");
			packages.add((parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/"));
		}
	}

	return { "relative": [...relative], "packages": [...packages] };
}

/** The package root of a node_modules-relative path: `@types/react/index.d.ts` → `@types/react`. */
function packageRootOf(rel: string): string {
	const parts = rel.split("/");

	return (parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/** Resolve `rel` (a `./x` reference from the file at `fromRel`) to candidate node_modules-relative `.d.ts` paths.
 *  Bounded to `fromRel`'s own package — a relative ref that escapes it (`../../other`) is dropped, not chased. */
function resolveRelative(fromRel: string, rel: string): string[] {
	const slash = fromRel.lastIndexOf("/");
	const baseDir = slash === -1 ? "" : fromRel.slice(0, slash);
	const joined = new URL(rel, "file:///" + baseDir + "/").pathname.slice(1); // normalize ./ and ../
	const root = packageRootOf(fromRel);

	if (root !== "" && joined !== root && !joined.startsWith(root + "/")) {
		return []; // escaped the package — a cross-package relative ref is a bug, not a type to fetch
	}

	if (/\.d\.[mc]?ts$/u.test(joined)) {
		return [joined];
	}

	return [joined + ".d.ts", joined + "/index.d.ts"]; // a bare ref → the file or a directory index
}

/**
 * Wire runtime type acquisition onto the workbench's vscode API. Runs on the active editor now and on every
 * active-editor change / document edit (debounced). Deduped across the session: a package/file is fetched once.
 */
export function installTypeAcquisition(api: typeof vscode, workspaceFolder: string, log: Logger): void {
	const nodeModules = workspaceFolder.replace(/\/$/u, "") + "/node_modules";
	// Same-origin base the SW intercepts; it proxies /workspace/node_modules/* to the CDN (unversioned → latest).
	const deployBase = location.pathname.slice(0, location.pathname.indexOf("/__vscode__/") + 1) || "/";

	const fetchedPath = new Set<string>();   // node_modules-relative paths already fetched (dedup + cycle guard)
	const seenPackage = new Set<string>();   // packages already acquired

	const cdnFetch = async (rel: string): Promise<string | undefined> => {
		try {
			const response = await fetch(new URL(`${deployBase}${nodeModules.replace(/^\//u, "")}/${rel}`, location.href).href);

			return response.ok ? await response.text() : undefined;
		} catch {
			return undefined; // offline / CDN error — acquisition is best-effort
		}
	};

	const write = async (rel: string, code: string): Promise<void> => {
		try {
			await api.workspace.fs.writeFile(api.Uri.file(`${nodeModules}/${rel}`), new TextEncoder().encode(code));
		} catch { /* already seeded (read-only) or unwritable — the existing copy stands */ }
	};

	// Fetch one .d.ts, write it, and crawl its references. `budget.n` bounds the whole run.
	const acquireFile = async (rel: string, budget: { "n": number }): Promise<void> => {
		if (fetchedPath.has(rel) || budget.n <= 0) {
			return;
		}

		fetchedPath.add(rel);
		budget.n -= 1;

		const code = await cdnFetch(rel);

		if (code === undefined) {
			return;
		}

		await write(rel, code);

		const { relative, packages } = references(code);

		for (const ref of relative) {
			for (const candidate of resolveRelative(rel, ref)) {
				await acquireFile(candidate, budget);
			}
		}

		for (const pkg of packages) {
			await acquirePackage(pkg, budget);
		}
	};

	async function acquirePackage(pkg: string, budget: { "n": number }): Promise<void> {
		if (seenPackage.has(pkg) || budget.n <= 0) {
			return;
		}

		seenPackage.add(pkg);

		const pkgJsonRel = `${pkg}/package.json`;
		fetchedPath.add(pkgJsonRel);
		budget.n -= 1;

		const raw = await cdnFetch(pkgJsonRel);

		if (raw === undefined) {
			// No package.json on the CDN (not published) → nothing to do; @types is only tried below for a real pkg.
			return;
		}

		await write(pkgJsonRel, raw);

		let entry: string | undefined;

		try {
			entry = typesEntry(JSON.parse(raw) as Record<string, unknown>);
		} catch { /* malformed package.json — fall through to @types */ }

		if (entry !== undefined) {
			await acquireFile(`${pkg}/${entry.replace(/^\.\//u, "")}`, budget);
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
		const budget = { "n": MAX_FETCHES };

		void Promise.all(packages.map((pkg) => acquirePackage(pkg, budget)))
			.then(() => span.end({ "fetched": fetchedPath.size }))
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
