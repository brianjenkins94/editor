import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";

export const STALE_AFTER_MS = 10 * 60_000;

export async function pruneStaleEntries(dist: string, { now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}): Promise<string[]> {
	const extensions = path.join(dist, "extensions");
	const removed: string[] = [];

	if (!fs.existsSync(extensions)) {
		return removed;
	}

	for (const name of fs.readdirSync(extensions)) {
		const folder = path.join(extensions, name);
		const manifest = path.join(folder, "package.json");
		const { browser } = fs.existsSync(manifest)
			? JSON.parse(fs.readFileSync(manifest, "utf8")) as { "browser"?: string }
			: {};

		for (const file of browser === undefined
			? []
			: fs.readdirSync(folder)) {
			const at = path.join(folder, file);

			if (/^extension-[0-9a-f]+\.js$/u.test(file) && file !== browser && now - fs.statSync(at).mtimeMs > staleAfterMs) {
				await fs.rm(at);
				removed.push(`${name}/${file}`);
			}
		}
	}

	return removed;
}
