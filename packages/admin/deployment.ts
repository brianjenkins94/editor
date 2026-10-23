import type { Plugin } from "vite";
import { parse } from "@brianjenkins94/util/json";
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
import * as url from "node:url";

/** This package's directory (import.meta.url, which Vite keeps right in a config's imports). */
const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * The deployment as configured (packages/api/README.md, "The architecture page"): every Worker, read from its wrangler config at build
 * time, so the architecture page is drawn from what's deployed rather than by hand. A Worker's environments are its
 * config's top level (`local`) and its `env` sections, each over the top level; a static site's config has none, and is
 * production's (its custom domain). The page imports it as `virtual:deployment`.
 */

/** The configs, from this package. */
const CONFIGS = ["../api/wrangler.jsonc", "../site/editor.jsonc", "../site/admin.jsonc", "../site/wrangler.jsonc"];

export interface Worker {
	/** The config it's from, from the repository's root. */
	"config": string;
	"name": string;
	/** Its custom domains, and whether it's on workers.dev. */
	"hosts": string[];
	"workersDev": boolean;
	/** Its code (absent for a Worker of static assets only), and its assets' directory. */
	"main"?: string;
	"assets"?: string;
	"crons": string[];
	"durableObjects": { "binding": string; "class": string }[];
	"databases": { "binding": string; "name": string }[];
	"buckets": { "binding": string; "name": string }[];
	"rateLimits": { "binding": string; "limit": number; "period": number }[];
	/** The hosts its assets' `_redirects` send visitors to (absolute targets only; a rewrite stays on the host). */
	"redirects": string[];
}

export type Deployment = Record<string, Worker[]>;

interface Config {
	"name": string;
	"main"?: string;
	"workers_dev"?: boolean;
	"routes"?: { "pattern": string; "custom_domain"?: boolean }[];
	"assets"?: { "directory": string };
	"triggers"?: { "crons"?: string[] };
	"durable_objects"?: { "bindings": { "name": string; "class_name": string }[] };
	"d1_databases"?: { "binding": string; "database_name": string }[];
	"r2_buckets"?: { "binding": string; "bucket_name": string }[];
	"ratelimits"?: { "name": string; "simple": { "limit": number; "period": number } }[];
	"env"?: Record<string, Partial<Config>>;
}

/** The hosts a static site's `_redirects` (in its assets' directory) sends to. */
function redirectsOf(file: string, assets: string | undefined): string[] {
	const redirects = assets === undefined ? undefined : path.resolve(HERE, path.dirname(file), assets, "_redirects");

	if (redirects === undefined || !fs.existsSync(redirects)) {
		return [];
	}

	return [...new Set([...fs.readFileSync(redirects, { "encoding": "utf-8" }).matchAll(/^\S+\s+https?:\/\/([^/\s:]+)/gmu)].map((match) => match[1] as string))];
}

function workerOf(file: string, config: Config): Worker {
	return {
		"config": path.relative(path.resolve(HERE, "../.."), path.resolve(HERE, file)),
		"name": config.name,
		"hosts": (config.routes ?? []).map((route) => route.pattern),
		"workersDev": config.workers_dev ?? true,
		...config.main === undefined ? {} : { "main": config.main },
		...config.assets === undefined ? {} : { "assets": config.assets.directory },
		"crons": config.triggers?.crons ?? [],
		"durableObjects": (config.durable_objects?.bindings ?? []).map((binding) => ({ "binding": binding.name, "class": binding.class_name })),
		"databases": (config.d1_databases ?? []).map((database) => ({ "binding": database.binding, "name": database.database_name })),
		"buckets": (config.r2_buckets ?? []).map((bucket) => ({ "binding": bucket.binding, "name": bucket.bucket_name })),
		"rateLimits": (config.ratelimits ?? []).map((limit) => ({ "binding": limit.name, "limit": limit.simple.limit, "period": limit.simple.period })),
		"redirects": redirectsOf(file, config.assets?.directory)
	};
}

/** Every environment's Workers. */
export function readDeployment(): Deployment {
	const deployment: Deployment = { "local": [], "dev": [], "production": [] };

	for (const file of CONFIGS) {
		const config = parse(fs.readFileSync(path.resolve(HERE, file), { "encoding": "utf-8" }), undefined, {}) as Config;

		if (config.env === undefined) {
			deployment["production"]?.push(workerOf(file, config));

			continue;
		}

		deployment["local"]?.push(workerOf(file, config));

		for (const [name, overrides] of Object.entries(config.env)) {
			(deployment[name] ??= []).push(workerOf(file, { ...config, ...overrides }));
		}
	}

	return deployment;
}

/** `virtual:deployment`: readDeployment(), as a module. */
export function deployment(): Plugin {
	const id = "virtual:deployment";

	return {
		"name": "deployment",
		"resolveId": (source) => (source === id ? `\0${id}` : undefined),
		"load": (loaded) => (loaded === `\0${id}` ? `export default ${JSON.stringify(readDeployment())};` : undefined),
		"configureServer": (server) => {
			for (const file of CONFIGS) {
				server.watcher.add(path.resolve(HERE, file));
			}
		}
	};
}
