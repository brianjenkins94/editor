/**
 * Bakes a snapshot of the bundled demo workspace into the build as the virtual module
 * `editor:workspace`, so the hosted workbench (GitHub Pages) opens on a real sample project — not a
 * fixture, not blank. main.tsx imports it and hands it to `createVscodeWindow({ files })`.
 *
 * Source = the fixed `demo/` directory in this package (NOT git — editor opens on a curated sample,
 * not on its own source). A later File System Access overlay adds a "real on-disk folder" source mode
 * alongside this one.
 *
 * A browse snapshot (this file) plus a dependency type surface (editorTypesPlugin, below) so the
 * in-browser TS language service resolves the demo's imports and reports no phantom errors.
 */
import type { Plugin } from "vite";
// eslint-disable-next-line ts/no-restricted-imports -- the snapshot is built synchronously at vite config-load time; the @brianjenkins94/util/fs wrapper is async-only
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const VIRTUAL = "editor:workspace";
const TYPES_VIRTUAL = "editor:types";
const VERSIONS_VIRTUAL = "editor:versions";
const FOLDER = "/workspace";                  // the explorer root the demo files mount under
const MAX_BYTES = 256 * 1024;                 // skip anything unexpectedly large

// Text/source extensions worth showing. Anything else (images, tarballs) is dropped; dotfiles
// are kept regardless since they carry no extension.
const TEXT = new Set(["ts", "tsx", "mjs", "cjs", "js", "jsx", "json", "md", "yml", "yaml", "html", "css", "txt"]);

export interface SnapshotFile { "path": string; "contents": string; "readonly"?: boolean }

/** This file's directory. */
function here(): string {
	return path.dirname(url.fileURLToPath(import.meta.url));
}

/** The bundled demo workspace directory. */
function demoDir(): string {
	return path.join(here(), "demo");
}

/** Nearest ancestor directory that has a node_modules (editor's workspace root, for type seeding). */
function nodeModulesRoot(): string | undefined {
	let dir = here();

	for (;;) {
		if (existsSync(path.join(dir, "node_modules"))) { return dir; }
		const parent = path.dirname(dir);

		if (parent === dir) { return undefined; }
		dir = parent;
	}
}

/** All files under `dir`, recursively (skips node_modules and dotdirs). */
function walk(dir: string): string[] {
	const out: string[] = [];

	const visit = (d: string): void => {
		let entries;

		try { entries = readdirSync(d, { "withFileTypes": true }); } catch { return; }

		for (const entry of entries) {
			if (entry.name === "node_modules" || (entry.name.startsWith(".") && entry.isDirectory())) { continue; }
			const abs = path.join(d, entry.name);

			if (entry.isDirectory()) { visit(abs); } else if (entry.isFile()) { out.push(abs); }
		}
	};

	visit(dir);

	return out;
}

function snapshot(): SnapshotFile[] {
	const demo = demoDir();

	if (!existsSync(demo)) { return []; }   // no demo yet → the workbench opens on an empty folder

	const files: SnapshotFile[] = [];

	for (const abs of walk(demo)) {
		const rel = path.relative(demo, abs).split(path.sep).join("/");
		const base = rel.slice(rel.lastIndexOf("/") + 1);
		const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();

		if (!TEXT.has(ext) && !base.startsWith(".")) { continue; }

		let stat;

		try { stat = statSync(abs); } catch { continue; }
		if (!stat.isFile() || stat.size > MAX_BYTES) { continue; }

		files.push({ "path": `${FOLDER}/${rel}`, "contents": readFileSync(abs, "utf8") });
	}

	return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function editorWorkspacePlugin(): Plugin {
	const resolved = "\0" + VIRTUAL;

	return {
		"name": "editor-workspace",
		"resolveId": (id) => (id === VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? `export default ${JSON.stringify(snapshot())};` : undefined)
	};
}

// ── Dependency type surface + CDN version map (node_modules for the in-browser TS server) ────────────
//
// The workspace snapshot above is browse-only. Without node_modules the workbench's TS language service
// can't resolve a single import, so every open file lights up with phantom "Cannot find module" /
// "Cannot find name 'process'" errors. Two cooperating pieces fix it:
//
//   • editorTypesPlugin (`editor:types`)  — SYNCHRONOUSLY seeds the declaration surface (package.json +
//     *.d.ts) of the packages the demo imports, plus @types/node (Node globals + `node:` builtins) and
//     the @tsconfig base. The TS worker resolves package.json/exports against a synchronous view an
//     async provider can't populate, so type-checking REQUIRES this up-front seed. Packages that ship
//     no types, are too heavy to bake, or are ambient (vscode) get a one-line `declare module` shim.
//
//   • editorVersionsPlugin (`editor:versions`) — a {name → version} map for the CDN (unpkg) filesystem
//     overlay (node-modules-provider.ts), which lazily fetches FULL package source on demand for
//     go-to-definition/hover into deps. unpkg 302-redirects UNVERSIONED requests without CORS headers,
//     so only pinned packages are servable — hence the map.

const DECL_SUFFIX = [".d.ts", ".d.mts", ".d.cts"];
const PKG_DECL_CAP = 600 * 1024;                     // per package: larger .d.ts surfaces get shimmed, not baked
const ALWAYS_REAL = new Set(["@types/node"]);        // Node globals + `node:` builtins — must resolve synchronously
const ALWAYS_SHIM = new Set(["vscode", "lucide"]);   // ambient host API / heavy value-less icon union
const AMBIENT_FILE = `${FOLDER}/editor-ambient.d.ts`; // root project .d.ts (see the note where it's written)

/** Bare package specifiers imported by the demo source, reduced to their package root (scope-aware). */
function importedPackages(): string[] {
	const roots = new Set<string>();

	for (const abs of walk(demoDir())) {
		if (!/\.(?:ts|tsx|mjs|cjs|js|jsx)$/u.test(abs)) { continue; }

		let src: string;

		try { src = readFileSync(abs, "utf8"); } catch { continue; }

		for (const match of src.matchAll(/(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu)) {
			const spec = match[1];

			if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("editor:")) { continue; }
			const parts = spec.split("/");
			const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

			if (pkg !== "" && !pkg.startsWith("@")) { roots.add(pkg); } else if (pkg.startsWith("@") && parts.length >= 2 && parts[1] !== "") { roots.add(pkg); }
		}
	}

	return [...roots];
}

/** package.json + tsconfig.json + declaration files under a package dir (recursive). */
function declFiles(dir: string): string[] {
	const out: string[] = [];

	const visit = (d: string): void => {
		let entries;

		try { entries = readdirSync(d, { "withFileTypes": true }); } catch { return; }

		for (const entry of entries) {
			const abs = path.join(d, entry.name);

			if (entry.isDirectory()) { visit(abs); } else if (entry.name === "package.json" || entry.name === "tsconfig.json" || DECL_SUFFIX.some((s) => entry.name.endsWith(s))) { out.push(abs); }
		}
	};

	visit(dir);

	return out;
}

/** Seed files (package.json + *.d.ts) for the imported packages, plus one ambient-shim module for the rest. */
function typeSurface(): SnapshotFile[] {
	const root = nodeModulesRoot();

	if (root === undefined) { return []; }

	const nm = path.join(root, "node_modules");
	const packages = [...new Set([...importedPackages(), ...ALWAYS_REAL])].sort();
	const files: SnapshotFile[] = [];
	const shims: string[] = [];
	let realPkgs = 0;
	let realBytes = 0;

	for (const pkg of packages) {
		if (ALWAYS_SHIM.has(pkg)) { shims.push(pkg); continue; }

		const dir = path.join(nm, pkg);

		if (!existsSync(dir)) { continue; }   // not installed (or a bogus match) — nothing to seed, TS falls to CDN/any

		const decls = declFiles(dir);
		const declBytes = decls.filter((f) => !f.endsWith(".json")).reduce((n, f) => { try { return n + statSync(f).size; } catch { return n; } }, 0);

		if (declBytes === 0) { shims.push(pkg); continue; }                              // ships no types → ambient any
		if (declBytes > PKG_DECL_CAP && !ALWAYS_REAL.has(pkg)) { shims.push(pkg); continue; }   // too heavy to bake → CDN + any

		for (const abs of decls) {
			let contents: string;

			try { contents = readFileSync(abs, "utf8"); } catch { continue; }
			files.push({ "path": `${FOLDER}/` + path.relative(root, abs).split(path.sep).join("/"), "contents": contents, "readonly": true });
			realBytes += contents.length;
		}

		realPkgs += 1;
	}

	// The tsconfig `extends` base(s): seed the whole (tiny) @tsconfig scope so the extends chain resolves.
	const tsconfigDir = path.join(nm, "@tsconfig");

	if (existsSync(tsconfigDir)) {
		for (const name of readdirSync(tsconfigDir)) {
			for (const file of ["package.json", "tsconfig.json"]) {
				const abs = path.join(tsconfigDir, name, file);

				if (existsSync(abs)) { files.push({ "path": `${FOLDER}/node_modules/@tsconfig/${name}/${file}`, "contents": readFileSync(abs, "utf8"), "readonly": true }); }
			}
		}
	}

	// The in-browser tsserver does NOT scan typeRoots for @types/* (confirmed empirically), so neither the
	// real @types/node nor an @types-style shim package resolves that way. A ROOT-LEVEL project .d.ts is
	// always part of the program, so it works instead: a triple-slash PATH reference force-includes the
	// seeded Node types (globals + `node:` builtins), and ambient `declare module` lines resolve the
	// shimmed packages to `any`.
	const nodeIndex = path.join(nm, "@types", "node", "index.d.ts");
	const nodeRef = existsSync(nodeIndex) ? `/// <reference path="./node_modules/@types/node/index.d.ts" />\n` : "";
	const body = shims.sort().map((p) => `declare module "${p}";\ndeclare module "${p}/*";`).join("\n");

	files.push({ "path": AMBIENT_FILE,
"readonly": true,
"contents":
		"// Auto-generated by editorTypesPlugin (snapshot.ts). The in-browser TS server doesn't scan typeRoots\n"
		+ "// for @types/*, so Node's global types are force-referenced by path, and packages that ship no types\n"
		+ "// (or are deliberately shimmed) get ambient `any` declarations. A project file, NOT an @types package.\n"
		+ nodeRef + body + "\n" });

	console.log(`[editor:types] seeded ${realPkgs} packages (${Math.round(realBytes / 1024)} KB of .d.ts), shimmed ${shims.length}: ${shims.join(", ")}`);

	return files;
}

/** {name → installed version} for the CDN overlay — registry packages only (tgz/@brianjenkins94 aren't on unpkg). */
function moduleVersions(): Record<string, string> {
	const root = nodeModulesRoot();

	if (root === undefined) { return {}; }

	const nm = path.join(root, "node_modules");
	const versions: Record<string, string> = {};

	for (const pkg of importedPackages()) {
		if (pkg.startsWith("@brianjenkins94/") || ALWAYS_SHIM.has(pkg)) { continue; }   // not on unpkg / shimmed to any

		try {
			const meta = JSON.parse(readFileSync(path.join(nm, pkg, "package.json"), "utf8")) as { "version"?: string };

			if (typeof meta.version === "string" && /^\d/u.test(meta.version)) { versions[pkg] = meta.version; }
		} catch { /* not installed — skip */ }
	}

	return versions;
}

export function editorTypesPlugin(): Plugin {
	const resolved = "\0" + TYPES_VIRTUAL;
	let cache: string | undefined;

	return {
		"name": "editor-types",
		"resolveId": (id) => (id === TYPES_VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? (cache ??= `export default ${JSON.stringify(typeSurface())};`) : undefined)
	};
}

export function editorVersionsPlugin(): Plugin {
	const resolved = "\0" + VERSIONS_VIRTUAL;

	return {
		"name": "editor-versions",
		"resolveId": (id) => (id === VERSIONS_VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? `export default ${JSON.stringify(moduleVersions())};` : undefined)
	};
}
