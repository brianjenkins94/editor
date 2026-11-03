/**
 * Bakes a snapshot of the bundled demo workspace into the build as the virtual module
 * `editor:workspace`, so the hosted workbench (GitHub Pages) opens on a real sample project — not a
 * fixture, not blank. main.tsx imports it and hands it to `createVscodeWindow({ files })`.
 *
 * Source = the fixed `demo/` directory in this package (NOT git — editor opens on a curated sample,
 * not on its own source). A later File System Access overlay adds a "real on-disk folder" source mode
 * alongside this one.
 *
 * A browse snapshot (this file) plus a dependency type surface (editorTypesPlugin, package-types.ts) so the
 * in-browser TS language service resolves the demo's imports and reports no phantom errors. And the editor's settings
 * defaults (`editor:settings-defaults`, below), the starter's settings without a `.vscode/` in it.
 */
import type { Plugin } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import * as utilFs from "@brianjenkins94/util/fs";
import { log } from "@brianjenkins94/util/logger";
import * as ts from "typescript";

const VIRTUAL = "editor:workspace";
export const FOLDER = "/workspace";                  // the explorer root the demo files mount under
const MAX_BYTES = 256 * 1024;                 // skip anything unexpectedly large

// Text/source extensions worth showing. Anything else (images, tarballs) is dropped; dotfiles
// are kept regardless since they carry no extension.
const TEXT = new Set(["ts", "tsx", "mjs", "cjs", "js", "jsx", "json", "md", "yml", "yaml", "html", "css", "txt"]);

// Root-level config files the EDITOR manages rather than the user: seeded read-only, so workspace-fs enforces it
// (the editor shows the lock + blocks Save, the vscode API and the terminal get a permission error). Matched
// against the workspace-relative path, so only the ROOT one is managed — a nested config the user makes stays
// theirs. (Editor settings aren't seeded as a file: see `editor:settings-defaults` below.)
const MANAGED_CONFIGS = new Set(["tsconfig.json", "jsconfig.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".gitignore"]);

export interface SnapshotFile { "path": string; "contents": string; "readonly"?: boolean }

/** The package's directory (this file is in its build/). */
function packageDir(): string {
	return path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
}

/** The bundled demo workspace directory. */
export function demoDir(): string {
	return path.join(packageDir(), "demo");
}

/** Nearest ancestor directory that has a node_modules (editor's workspace root, for type seeding). */
export function nodeModulesRoot(): string | undefined {
	const nodeModules = utilFs.closest(packageDir(), "node_modules");

	return nodeModules === undefined ? undefined : path.dirname(nodeModules);
}

/** `readFileSync` as UTF-8, or undefined when the file can't be read. */
export function readText(abs: string): string | undefined {
	try {
		return utilFs.readFileSync(abs);
	} catch {
		return undefined;
	}
}

/** `statSync`, or undefined when the path can't be stat'd. */
export function statOf(abs: string): ReturnType<typeof utilFs.statSync> | undefined {
	try {
		return utilFs.statSync(abs);
	} catch {
		return undefined;
	}
}

/** All files under `dir`, recursively (skips node_modules and dotdirs). */
export function walk(dir: string): string[] {
	const out: string[] = [];

	const visit = (current: string): void => {
		let entries;

		try {
			entries = utilFs.readdirSync(current, { "withFileTypes": true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const skip = entry.name === "node_modules" || (entry.name.startsWith(".") && entry.isDirectory());

			if (!skip) {
				const abs = path.join(current, entry.name);

				if (entry.isDirectory()) {
					visit(abs);
				} else if (entry.isFile()) {
					out.push(abs);
				}
			}
		}
	};

	visit(dir);

	return out;
}

function snapshot(): SnapshotFile[] {
	const demo = demoDir();

	if (!utilFs.existsSync(demo)) {
		return [];   // no demo yet → the workbench opens on an empty folder
	}

	const files: SnapshotFile[] = [];

	for (const abs of walk(demo)) {
		const rel = path.relative(demo, abs).split(path.sep).join("/");
		const base = rel.slice(rel.lastIndexOf("/") + 1);
		const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();

		if (TEXT.has(ext) || base.startsWith(".")) {
			const stat = statOf(abs);

			if (stat !== undefined && stat.isFile() && stat.size <= MAX_BYTES) {
				files.push({ "path": `${FOLDER}/${rel}`, "contents": utilFs.readFileSync(abs), "readonly": MANAGED_CONFIGS.has(rel) });
			}
		}
	}

	return files.sort((first, second) => first.path.localeCompare(second.path));
}

export function editorWorkspacePlugin(): Plugin {
	const resolved = "\0" + VIRTUAL;

	return {
		"name": "editor-workspace",
		"resolveId": (id) => (id === VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? `export default ${JSON.stringify(snapshot())};` : undefined)
	};
}

// ── Settings defaults (`editor:settings-defaults`) ────────────────────────────────────────────────────────────
//
// The editor's curated settings (settings-defaults.jsonc — the user's lib/.vscode/settings.json), parsed (JSONC —
// comments, trailing commas) into the object the workbench registers as CONFIGURATION DEFAULTS, the lowest settings
// layer. VS Code merges settings layers per key, so a workspace `.vscode/settings.json` that sets only a theme — or
// a loaded repo's own — still inherits the eslint fix-all / format-on-save setup for every key it doesn't set, while
// any key it does set wins. That's why no `.vscode/` is seeded into the workspace: it belongs to the user or repo.

const SETTINGS_DEFAULTS_VIRTUAL = "editor:settings-defaults";

/** settings-defaults.jsonc as an object ({} when absent or unparsable). */
function settingsDefaults(): Record<string, unknown> {
	const file = path.join(packageDir(), "settings-defaults.jsonc");
	const text = readText(file);

	if (text === undefined) {
		return {};
	}

	const { config, error } = ts.parseConfigFileTextToJson(file, text);

	if (error !== undefined || config === null || typeof config !== "object") {
		log.warn(`[editor:settings-defaults] couldn't parse ${file}; no settings defaults registered`);

		return {};
	}

	return config as Record<string, unknown>;
}

export function editorSettingsDefaultsPlugin(): Plugin {
	const resolved = "\0" + SETTINGS_DEFAULTS_VIRTUAL;

	return {
		"name": "editor-settings-defaults",
		"resolveId": (id) => (id === SETTINGS_DEFAULTS_VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? `export default ${JSON.stringify(settingsDefaults())};` : undefined)
	};
}
