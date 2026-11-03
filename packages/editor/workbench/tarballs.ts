/**
 * A package's published tarball, at the version the editor pins (versions.ts) — what a debug run's `require` installs
 * into its own memory when nothing in node_modules has the package (the bridge asks for it, for the debug worker:
 * `packages.tarball`). Nothing is written to the workspace: its filesystem is a fixed-size shared buffer, too small for
 * anyone's node_modules.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { VersionsFile } from "./versions";
import { keptAt } from "@brianjenkins94/editor-api/git";
import { tarballUrl } from "@brianjenkins94/editor-api/runtime";
import { serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
import { versionsPath } from "@brianjenkins94/util/silo/layout";

// Each fetch is a span: it crosses the network, and a debug run waits on it.
const log = logger({ "source": "workbench" });

/** Each tarball fetched this session, by URL (its bytes never change: a version is published once). */
const fetched = new Map<string, Promise<Uint8Array>>();

/** `name`@`version`'s published tarball, gzipped (fetched once a session). */
export function tarball(name: string, version: string, resolved?: string): Promise<Uint8Array> {
	const url = tarballUrl(name, version, resolved);

	if (!fetched.has(url)) {
		fetched.set(url, log.span("editor.workbench.tarballs.fetch", { "name": name, "version": version }, async (span) => {
			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`${name}@${version}: ${response.status} from ${url}`);
			}

			const bytes = new Uint8Array(await response.arrayBuffer());

			span.end({ "bytes": bytes.length });

			return bytes;
		}).catch((error: unknown) => {
			fetched.delete(url);

			throw error;
		}));
	}

	return fetched.get(url)!;
}

/** The most of a package's dependencies prefetched at once (prefetchDependencies): a closure that big is a mistake's. */
const PREFETCH_MAX = 64;

/**
 * What `name` depends on, and theirs in turn (versions.json's `dependencies`), fetched alongside it and not waited on.
 * A debug run installs a package as its code first requires it, waiting on each — its worker blocks until the tarball
 * is in, so a package with a dozen dependencies was a dozen waits, one after another (2–10 s each on a busy page). Asked
 * for together, each is in or on its way when the run gets to it (each is kept once a page). A linked folder or a
 * platform build is nothing to fetch.
 */
function prefetchDependencies(name: string, packages: VersionsFile["packages"]): void {
	const seen = new Set([name]);
	const queue = [...packages[name]?.dependencies ?? []];

	while (queue.length > 0 && seen.size <= PREFETCH_MAX) {
		const dependency = queue.shift()!;
		const entry = packages[dependency];

		if (seen.has(dependency) || entry === undefined || entry.link !== undefined || entry.platform === true) {
			continue;
		}

		seen.add(dependency);
		queue.push(...entry.dependencies ?? []);
		void tarball(dependency, entry.version, entry.tarball).catch(() => undefined); // (asked again when it's required)
	}
}

/** A package a debug run's require found nothing of: its tarball, at the version the run read pinned (the bridge asks,
 *  for the run — the debug worker installs it in its own memory). From the lockfile's URL when it names that version. */
export function installTarballs(vscode: typeof vscodeApi, hub: Hub): void {
	const exists = async (path: string): Promise<boolean> => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`/workspace/${path}`))).then(() => true, () => false);

	serve(hub, "packages.tarball", async (args) => {
		const { name, version } = (args ?? {}) as { "name"?: unknown; "version"?: unknown };

		if (typeof name !== "string" || typeof version !== "string") {
			throw new TypeError("packages.tarball: a name and a version");
		}

		const packages = await vscode.workspace.fs.readFile(vscode.Uri.file(`/workspace/${await keptAt(versionsPath(), exists)}`)).then((bytes) => (JSON.parse(new TextDecoder().decode(bytes)) as VersionsFile).packages, () => undefined);
		const pinned = packages?.[name];

		if (packages !== undefined) {
			prefetchDependencies(name, packages);
		}

		return tarball(name, version, pinned?.version === version ? pinned.tarball : undefined);
	});
}
