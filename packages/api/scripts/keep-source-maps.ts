/**
 * The editor's source maps, kept per release (README.md O7). Production's deploy (.github/workflows/production.yml)
 * builds the site with hidden maps (SOURCE_MAPS=hidden: packages/editor/build.ts), then runs this: each map goes into
 * the editor-source-maps bucket as `<release>/<its path in the site>`, its sources rewritten as repo paths and without
 * their text (GitHub has that, at the release), and leaves the site, which never serves them. The admin app maps an
 * editor stack through them as it shows it (GET /admin/errors/maps/…). The bucket forgets them after 45 days.
 *
 *   node scripts/keep-source-maps.ts <site folder> <release> [--dry-run]
 *
 * Through Cloudflare's API with CLOUDFLARE_API_TOKEN (it needs Workers R2 Storage: Edit) and CLOUDFLARE_ACCOUNT_ID;
 * --dry-run rewrites and measures them but uploads and removes nothing.
 */
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const BUCKET = "editor-source-maps";

/** Uploads at once. */
const PARALLEL = 16;

const { values, positionals } = parseArgs({ "allowPositionals": true, "options": { "dry-run": { "type": "boolean", "default": false } } });
const [site, release] = positionals;

if (site === undefined || release === undefined || !/^[\w.-]{1,40}$/u.test(release)) {
	throw new Error("Usage: node scripts/keep-source-maps.ts <site folder> <release> [--dry-run]");
}

const root = path.resolve(import.meta.dirname, "../../..");
const siteRoot = path.resolve(site);

/** Where a site folder's files were built: the site itself (the host pages), or, under __vscode__/, the editor's dist/
 *  or the monaco component's (each map's sources are relative to where it was written). */
const builtIn = (folder: string): string[] => {
	const inner = folder.replace(/^__vscode__(?:\/|$)/u, "");

	return [path.join(siteRoot, folder), path.join(root, "packages/editor/dist", inner), path.join(root, "components/monaco-vscode-api/dist", inner)];
};

const clean = (source: string): string => source.replace(/[?#].*$/u, "");

/** A map, its sources as repo paths (from whichever build folder most of them exist under), its text left out. */
function rewrite(file: string): string {
	const map = JSON.parse(fs.readFileSync(path.join(siteRoot, file))) as { "sources": string[]; "sourceRoot"?: string; "sourcesContent"?: unknown };
	const sources = map.sources.map((source) => clean(path.join(map.sourceRoot ?? "", source)));
	const [base] = builtIn(path.dirname(file)).map((folder) => ({ folder, "found": sources.filter((source) => fs.existsSync(path.resolve(folder, source))).length })).toSorted((a, b) => b.found - a.found);

	map.sources = sources.map((source) => path.relative(root, path.resolve(base?.folder ?? siteRoot, source)).split(path.sep).join("/"));
	delete map.sourceRoot;
	delete map.sourcesContent;

	return JSON.stringify(map);
}

async function upload(key: string, body: string): Promise<void> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${process.env["CLOUDFLARE_ACCOUNT_ID"]}/r2/buckets/${BUCKET}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;

	for (let attempt = 1; ; attempt += 1) {
		const answer = await fetch(url, { "method": "PUT", "headers": { "authorization": `Bearer ${process.env["CLOUDFLARE_API_TOKEN"]}`, "content-type": "application/json" }, "body": body });

		if (answer.ok) {
			return;
		}

		if (answer.status === 401 || answer.status === 403) {
			// Which token it was (its id, not its value), to find it in the dashboard, and Cloudflare's own words.
			const token = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { "headers": { "authorization": `Bearer ${process.env["CLOUDFLARE_API_TOKEN"]}` } }).then(async (verified) => (await verified.json() as { "result"?: { "id"?: string } }).result?.id, () => undefined);

			throw new Error(`Cloudflare refused ${key} (${answer.status}: ${(await answer.text()).slice(0, 300)}): the API token (id ${token ?? "unknown"}) needs Workers R2 Storage: Edit on this account.`);
		}

		if (attempt === 3) {
			throw new Error(`Couldn't keep ${key}: ${answer.status} ${await answer.text()}`);
		}
	}
}

const maps = (fs.readdirSync(siteRoot, { "recursive": true }) as string[]).filter((file) => file.endsWith(".map")).map((file) => file.split(path.sep).join("/"));
let bytes = 0;
let next = 0;

await Promise.all(Array.from({ "length": PARALLEL }, async () => {
	while (next < maps.length) {
		const file = maps[next] as string;

		next += 1;

		const body = rewrite(file);

		bytes += body.length;

		if (!values["dry-run"]) {
			await upload(`${release}/${file}`, body);
			await fs.rm(path.join(siteRoot, file));
		}
	}
}));

console.log(`${values["dry-run"] ? "Would keep" : "Kept"} ${maps.length} source maps for ${release} (${Math.round(bytes / 1_048_576)} MB) in ${BUCKET}.`);
