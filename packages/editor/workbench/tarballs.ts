/**
 * A package's published tarball, at the version the editor pins (versions.ts) — what a debug run's `require` installs
 * into its own memory when nothing in node_modules has the package (the bridge asks for it, for the debug worker:
 * `packages.tarball`). Nothing is written to the workspace: its filesystem is a fixed-size shared buffer, too small for
 * anyone's node_modules.
 */
import { tarballUrl } from "@brianjenkins94/editor-api/runtime";

/** Each tarball fetched this session, by URL (its bytes never change: a version is published once). */
const fetched = new Map<string, Promise<Uint8Array>>();

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
