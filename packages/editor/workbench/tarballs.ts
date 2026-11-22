import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { VersionsFile } from "./versions";
import { keptAt } from "@brianjenkins94/editor-api/git";
import { tarballUrl } from "@brianjenkins94/editor-api/runtime";
import { serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
import { versionsPath } from "@brianjenkins94/util/silo/layout";

const log = logger({ "source": "workbench" });

const fetched = new Map<string, Promise<Uint8Array>>();

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

const PREFETCH_MAX = 64;

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
		void tarball(dependency, entry.version, entry.tarball).catch(() => undefined);
	}
}

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
