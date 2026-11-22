import type { Plugin } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import * as utilFs from "@brianjenkins94/util/fs";
import { log } from "@brianjenkins94/util/logger";
import * as ts from "typescript";

const VIRTUAL = "editor:workspace";
export const FOLDER = "/workspace";
const MAX_BYTES = 256 * 1024;

const TEXT = new Set(["ts", "tsx", "mjs", "cjs", "js", "jsx", "json", "md", "yml", "yaml", "html", "css", "txt"]);

const MANAGED_CONFIGS = new Set(["tsconfig.json", "jsconfig.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".gitignore"]);

export interface SnapshotFile { "path": string; "contents": string; "readonly"?: boolean }

function packageDir(): string {
	return path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
}

export function demoDir(): string {
	return path.join(packageDir(), "demo");
}

export function nodeModulesRoot(): string | undefined {
	const nodeModules = utilFs.closest(packageDir(), "node_modules");

	return nodeModules === undefined ? undefined : path.dirname(nodeModules);
}

export function readText(abs: string): string | undefined {
	try {
		return utilFs.readFileSync(abs);
	} catch {
		return undefined;
	}
}

export function statOf(abs: string): ReturnType<typeof utilFs.statSync> | undefined {
	try {
		return utilFs.statSync(abs);
	} catch {
		return undefined;
	}
}

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
		return [];
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

const SETTINGS_DEFAULTS_VIRTUAL = "editor:settings-defaults";

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
