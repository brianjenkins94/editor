/**
 * A package's published tarball, at the version the editor pins (versions.ts) — what the baseline reads a package's code
 * from (baseline.ts), and what a debug run's `require` installs into its own memory when nothing in node_modules has the
 * package (the bridge asks for it, for the debug worker: `packages.tarball`). Nothing is written to the workspace: its
 * filesystem is a fixed-size shared buffer, too small for anyone's node_modules.
 */
import { unpack } from "@brianjenkins94/almostnode/packages";

/** Each tarball fetched this session, by URL (its bytes never change: a version is published once). */
const fetched = new Map<string, Promise<Uint8Array>>();

/** `name`@`version`'s tarball URL: a lockfile's `resolved`, else npm's registry's. */
export const tarballUrl = (name: string, version: string, resolved?: string): string => resolved ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;

/** `name`@`version`'s published tarball, gzipped (fetched once a session). */
export function tarball(name: string, version: string, resolved?: string): Promise<Uint8Array> {
	const url = tarballUrl(name, version, resolved);

	if (!fetched.has(url)) {
		fetched.set(url, fetch(url).then(async (response) => {
			if (!response.ok) {
				throw new Error(`${name}@${version}: ${response.status} from ${url}`);
			}

			return new Uint8Array(await response.arrayBuffer());
		}).catch((error: unknown) => {
			fetched.delete(url);

			throw error;
		}));
	}

	return fetched.get(url)!;
}

/** `name`@`version`'s files, by path within the package — those `wanted` picks. */
export async function packageFiles(name: string, version: string, resolved?: string, wanted: (path: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
	return new Map([...unpack(await tarball(name, version, resolved))].filter(([path]) => wanted(path)));
}
