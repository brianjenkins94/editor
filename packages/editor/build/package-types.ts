/**
 * The starter workspace's packages, baked into the build for the in-browser TS server (`editor:types`) and the CDN
 * overlay's versions (`editor:versions`); and, in dev, the CDN fallback the service worker gives a static host.
 */
import type { Plugin } from "vite";
import type { SnapshotFile } from "./snapshot";
import * as path from "node:path";
import * as utilFs from "@brianjenkins94/util/fs";
import { log } from "@brianjenkins94/util/logger";
import { packageName } from "@brianjenkins94/util/vite/external";
import { demoDir, FOLDER, nodeModulesRoot, readText, statOf, walk } from "./snapshot";

const TYPES_VIRTUAL = "editor:types";
const VERSIONS_VIRTUAL = "editor:versions";

// The workspace snapshot (snapshot.ts) is browse-only. Without node_modules the workbench's TS language service
// can't resolve a single import, so every open file lights up with phantom "Cannot find module" /
// "Cannot find name 'process'" errors. Two cooperating pieces fix it:
//
//   • editorTypesPlugin (`editor:types`)  — SYNCHRONOUSLY seeds the declaration surface (package.json +
//     *.d.ts) of the packages the demo imports, plus the @tsconfig base. The TS worker resolves package.json/exports against a synchronous view an
//     async provider can't populate, so type-checking REQUIRES this up-front seed. Packages that ship
//     no types, are too heavy to bake, or are ambient (vscode) get a one-line `declare module` shim.
//
//   • editorVersionsPlugin (`editor:versions`) — a {name → version} map for the CDN (unpkg) filesystem
//     overlay (node-modules-provider.ts), which lazily fetches FULL package source on demand for
//     go-to-definition/hover into deps. unpkg 302-redirects UNVERSIONED requests without CORS headers,
//     so only pinned packages are servable — hence the map.

const DECL_SUFFIX = [".d.ts", ".d.mts", ".d.cts"];
const PKG_DECL_CAP = 600 * 1024;                     // per package: larger .d.ts surfaces get shimmed, not baked
// The bake is just the offline PREWARM of the demo's imported deps (react/react-dom); everything else — including
// `@types/node` for a file that `/// <reference types="node">`s it (2.6 MB of Node globals the browser-only demo
// never uses, dropped in unification M2) — is acquired at runtime by ata.ts and persisted in the zen-fs store.
const ALWAYS_SHIM = new Set(["vscode", "lucide"]);   // ambient host API / heavy value-less icon union
const AMBIENT_FILE = `${FOLDER}/editor-ambient.d.ts`; // root project .d.ts for shims (see the note where it's written)

/** Bare package specifiers imported by the demo source, reduced to their package root (scope-aware). */
function importedPackages(): string[] {
	const roots = new Set<string>();

	for (const abs of walk(demoDir())) {
		const src = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/u.test(abs) ? readText(abs) : undefined;

		if (src !== undefined) {
			for (const match of src.matchAll(/(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu)) {
				const [, spec] = match;
				const external = !(spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("editor:"));

				if (external) {
					const pkg = packageName(spec);

					// Skip a bare scope with no name ("@scope" alone); keep "name" and "@scope/name".
					if (pkg !== "" && !(pkg.startsWith("@") && !pkg.includes("/"))) {
						roots.add(pkg);
					}
				}
			}
		}
	}

	return [...roots];
}

/** The DefinitelyTyped counterpart of a package: `react` → `@types/react`, `@scope/name` → `@types/scope__name`. */
function typesCounterpart(pkg: string): string {
	return pkg.startsWith("@") ? "@types/" + pkg.slice(1).replace("/", "__") : "@types/" + pkg;
}

/** package.json + tsconfig.json + declaration files under a package dir (recursive). */
function declFiles(dir: string): string[] {
	const out: string[] = [];

	const visit = (current: string): void => {
		let entries;

		try {
			entries = utilFs.readdirSync(current, { "withFileTypes": true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const abs = path.join(current, entry.name);

			if (entry.isDirectory()) {
				visit(abs);
			} else if (entry.name === "package.json" || entry.name === "tsconfig.json" || DECL_SUFFIX.some((suffix) => entry.name.endsWith(suffix))) {
				out.push(abs);
			}
		}
	};

	visit(dir);

	return out;
}

/** Seed one package's .d.ts files into `files`, returning the bytes seeded — or undefined when the
 *  package should be shimmed instead (ships no types, or too heavy to bake). */
function seedDecls(root: string, pkg: string, dir: string, files: SnapshotFile[]): number | undefined {
	const decls = declFiles(dir);
	const declBytes = decls.filter((file) => !file.endsWith(".json")).reduce((total, file) => total + Number(statOf(file)?.size ?? 0), 0);

	// ships no types → ambient any; too heavy to bake → CDN + any. @types/* packages ARE the type surface, so
	// they bake regardless of size (shimming them would defeat the point).
	if (declBytes === 0 || (declBytes > PKG_DECL_CAP && !pkg.startsWith("@types/"))) {
		return undefined;
	}

	let realBytes = 0;

	for (const abs of decls) {
		const contents = readText(abs);

		if (contents !== undefined) {
			files.push({ "path": `${FOLDER}/` + path.relative(root, abs).split(path.sep).join("/"), "contents": contents, "readonly": true });
			realBytes += contents.length;
		}
	}

	return realBytes;
}

/** Seed files (package.json + *.d.ts) for the imported packages, plus one ambient-shim module for the rest. */
function typeSurface(): SnapshotFile[] {
	const root = nodeModulesRoot();

	if (root === undefined) {
		return [];
	}

	const nm = path.join(root, "node_modules");
	const packages = [...new Set(importedPackages())].sort();
	const files: SnapshotFile[] = [];
	const shims: string[] = [];
	let realPkgs = 0;
	let realBytes = 0;

	// Seed one package's decls. Returns true if real types landed.
	const seedPackage = (pkg: string): boolean => {
		const dir = path.join(nm, pkg);

		if (!utilFs.existsSync(dir)) {
			return false;   // not installed (or a bogus match) — nothing to seed
		}

		const seeded = seedDecls(root, pkg, dir, files);

		if (seeded === undefined) {
			return false;
		}

		realBytes += seeded;
		realPkgs += 1;

		return true;
	};

	// Bake JUST a package's package.json. A no-types package whose types come from an @types counterpart still
	// needs its own manifest seeded synchronously: without it, tsserver directory-probes `node_modules/<pkg>` and
	// — via the async CDN overlay — resolves `<pkg>/index.ts` (an empty stub) to "is not a module", never reaching
	// the @types surface (incl. the JSX namespace) on the FIRST load, before ATA fills the store. The manifest
	// makes resolution follow package.json → @types instead. (react/react-dom ship no .d.ts, so this is them.)
	const seedManifest = (pkg: string): void => {
		const manifest = path.join(nm, pkg, "package.json");

		if (utilFs.existsSync(manifest)) {
			files.push({ "path": `${FOLDER}/` + path.relative(root, manifest).split(path.sep).join("/"), "contents": utilFs.readFileSync(manifest), "readonly": true });
		}
	};

	for (const pkg of packages) {
		if (ALWAYS_SHIM.has(pkg)) {
			shims.push(pkg);
		} else {
			// A package's own types, plus its DefinitelyTyped counterpart (react → @types/react): react/react-dom ship
			// no types, so the @types package is what provides the module types AND the global JSX namespace.
			const ownTypes = seedPackage(pkg);
			const typesPkg = pkg.startsWith("@types/") ? undefined : typesCounterpart(pkg);
			const viaTypes = typesPkg !== undefined && seedPackage(typesPkg);

			// Covered by @types but ships no own types → bake its manifest so resolution follows it to @types rather
			// than probing the physical (async-served) tree and stalling on an empty `<pkg>/index.ts`.
			if (viaTypes && !ownTypes) {
				seedManifest(pkg);
			}

			if (!ownTypes && !viaTypes) {
				shims.push(pkg);   // ships no types and has no installed @types counterpart → ambient any
			}
		}
	}

	// The tsconfig `extends` base(s): seed the whole (tiny) @tsconfig scope so the extends chain resolves.
	const tsconfigDir = path.join(nm, "@tsconfig");

	if (utilFs.existsSync(tsconfigDir)) {
		for (const name of utilFs.readdirSync(tsconfigDir)) {
			for (const file of ["package.json", "tsconfig.json"]) {
				const abs = path.join(tsconfigDir, name, file);

				if (utilFs.existsSync(abs)) {
					files.push({ "path": `${FOLDER}/node_modules/@tsconfig/${name}/${file}`, "contents": utilFs.readFileSync(abs), "readonly": true });
				}
			}
		}
	}

	// Packages that ship no types (or are deliberately shimmed) resolve to `any` via ambient `declare module` lines in
	// a root project .d.ts — written only when the demo imports such a package, so the starter carries no such file.
	if (shims.length > 0) {
		files.push({
			"path": AMBIENT_FILE,
			"readonly": true,
			"contents":
				"// Auto-generated by editorTypesPlugin (package-types.ts): ambient `any` declarations for packages that ship no\n"
				+ "// types (or are deliberately shimmed). A project file, NOT an @types package.\n"
				+ shims.sort().map((pkg) => `declare module "${pkg}";\ndeclare module "${pkg}/*";`).join("\n") + "\n"
		});
	}

	log.info(`[editor:types] seeded ${realPkgs} packages (${Math.round(realBytes / 1024)} KB of .d.ts), shimmed ${shims.length}: ${shims.join(", ")}`);

	return files;
}

/** {name → installed version} for the CDN overlay — registry packages only (tgz/@brianjenkins94 aren't on unpkg). */
function moduleVersions(): Record<string, string> {
	const root = nodeModulesRoot();

	if (root === undefined) {
		return {};
	}

	const nm = path.join(root, "node_modules");
	const versions: Record<string, string> = {};

	for (const pkg of importedPackages()) {
		// Skip packages not on unpkg (@brianjenkins94/*) or shimmed to any.
		if (!pkg.startsWith("@brianjenkins94/") && !ALWAYS_SHIM.has(pkg)) {
			try {
				const meta = JSON.parse(utilFs.readFileSync(path.join(nm, pkg, "package.json"), "utf8")) as { "version"?: string };

				if (typeof meta.version === "string" && /^\d/u.test(meta.version)) {
					versions[pkg] = meta.version;
				}
			} catch {
				// not installed — skip
			}
		}
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

/** The store root the resolver serves; node_modules (where the CDN fallback lives) sits under it. */
const NODE_MODULES = "/workspace/node_modules/";

/**
 * Dev-only mirror of the resolver's node_modules CDN fallback (public/coi-serviceworker.js `fetchCdn`). In
 * production the COI service worker answers a store miss under `/workspace/node_modules/` by fetching the
 * package from the CDN and re-serving it same-origin; in dev no service worker runs in the in-app pane (the
 * page is isolated by the coi-headers middleware directly), so this middleware does the same job — match a
 * `…/workspace/node_modules/<pkg>/<sub>` request, reconstruct the CDN URL from `?v=` (pinned version) and
 * `?meta` (directory listing), fetch it, and pipe it back. The node_modules overlay hits this uniformly in
 * both modes; this is the fold-in that retired the old `__proxy__` route.
 */
export function nodeModulesCdnPlugin(): Plugin {
	return {
		"name": "node-modules-cdn",

		"configureServer": function(server) {
			server.middlewares.use((req, res, next) => {
				const [pathname, rawQuery] = (req.url ?? "").split("?");
				const index = pathname.indexOf(NODE_MODULES);

				if (index === -1) {
					next();

					return;
				}

				const rel = pathname.slice(index + NODE_MODULES.length);
				const at = rel.startsWith("@") ? rel.indexOf("/", rel.indexOf("/") + 1) : rel.indexOf("/");
				const pkg = at === -1 ? rel : rel.slice(0, at);
				const sub = at === -1 ? "" : rel.slice(at + 1);
				const params = new URLSearchParams(rawQuery ?? "");
				const version = params.get("v");
				const spec = pkg + (version === null ? "" : "@" + version) + (sub === "" ? "" : "/" + sub);
				const upstream = "https://unpkg.com/" + spec + (params.has("meta") ? "?meta" : "");

				fetch(upstream).then(async (response) => {
					const body = Buffer.from(await response.arrayBuffer());
					const contentType = response.headers.get("content-type");

					res.statusCode = response.status;

					if (contentType !== null) {
						res.setHeader("content-type", contentType);
					}

					res.setHeader("cache-control", "no-cache");
					// Same-origin to the isolated iframe (no CORP strictly needed), but set it to match the prod SW.
					res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
					res.end(body);
				}).catch((error: unknown) => {
					res.statusCode = 502;
					res.end("cdn error: " + (error instanceof Error ? error.message : "unknown"));
				});
			});
		}
	};
}
