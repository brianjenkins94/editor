/**
 * The dependency-capability baseline (`.silo/baseline.json`, lib's util/silo/audit.ts `Baseline`), made in the editor
 * when the workspace has none — the editor's `silo init`: what each package the project depends on can do, read off its
 * own code, accepted as it is now. Made once, never remade: a change to it is an approval (silo's ensureBaseline), and a
 * run never teaches it (a compromised version would approve itself) — what runs see a package do beyond it is a finding.
 *
 * The packages are the ones the project would install, by name@version: a package-lock.json's, where there is one; else
 * each package.json's dependency ranges resolved as the preview resolves them (esm.sh), and theirs in turn. What each can
 * do is lib's `detect` over the code files of its published tarball (npm's registry) — its own files, as
 * installedPackages reads them on desktop, never what it depends on (each dependency is its own entry). There's no
 * node_modules to walk here: the editor serves packages from a CDN.
 *
 * `consumer` (what the project's own code imports, and how) isn't made here — desktop silo's establishBaseline does.
 */
import type * as vscodeApi from "vscode";
import { detect } from "@brianjenkins94/util/silo/detect";
import { baselinePath, SILO_DIR } from "@brianjenkins94/util/silo/layout";

/** A package as the baseline accepts it: its version, and what its own code can do. */
interface Accepted { "version": string; "caps": string[] }

/** A package to read: by name and exact version, and its tarball (a lockfile's `resolved`, else the registry's). */
interface Wanted { "name": string; "version": string; "tarball"?: string }

/** How many packages are fetched and read at once. */
const PARALLEL = 4;

/** A tarball's code files, by path (under `package/`): what detect reads. */
const CODE = /\.[cm]?js$/u;

/** The code files' texts in a .tgz: gunzipped, then its tar entries read (ustar, with pax and GNU long names). */
export async function tarballTexts(gzipped: ReadableStream<Uint8Array>, wanted: (path: string) => boolean = (path) => CODE.test(path)): Promise<Map<string, string>> {
	const bytes = new Uint8Array(await new Response(gzipped.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	const decoder = new TextDecoder();
	const field = (at: number, length: number): string => decoder.decode(bytes.subarray(at, at + length)).replace(/\0[\s\S]*$/u, "");
	const texts = new Map<string, string>();
	let longName: string | undefined;

	for (let at = 0; at + 512 <= bytes.length;) {
		const name = field(at, 100);

		if (name === "") {
			break; // the two empty blocks that end it
		}

		const size = Number.parseInt(field(at + 124, 12).trim() || "0", 8);
		const type = field(at + 156, 1);
		const prefix = field(at + 345, 155);
		const body = bytes.subarray(at + 512, at + 512 + size);
		const path = longName ?? (prefix === "" ? name : `${prefix}/${name}`);

		longName = undefined;

		if (type === "x") {
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(decoder.decode(body))?.[1];
		} else if (type === "L") {
			longName = decoder.decode(body).replace(/\0[\s\S]*$/u, "");
		} else if ((type === "0" || type === "") && wanted(path)) {
			texts.set(path, decoder.decode(body));
		}

		at += 512 + Math.ceil(size / 512) * 512;
	}

	return texts;
}

/** What `name`@`version`'s own code can do: detect over each of its tarball's code files. */
async function capsOf(name: string, version: string, tarball?: string): Promise<string[]> {
	const url = tarball ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
	const response = await fetch(url);

	if (!response.ok || response.body === null) {
		throw new Error(`${name}@${version}: ${response.status} from ${url}`);
	}

	const caps = new Set<string>();

	for (const text of (await tarballTexts(response.body)).values()) {
		for (const cap of detect(text)) {
			caps.add(cap);
		}
	}

	return [...caps].toSorted();
}

/** A dependency range the registry can resolve (not a file:, link:, git or URL dependency, nor an npm: alias). */
const resolvable = (range: string): boolean => !/^(?:file|link|workspace|git|git\+[a-z]+|https?|npm):|\//u.test(range);

/** `name`@`range` as the preview resolves it (esm.sh redirects a range to the exact version): its version, and its own
 *  dependencies. */
async function resolve(name: string, range: string): Promise<{ "version": string; "dependencies": Record<string, string> } | undefined> {
	const response = await fetch(`https://esm.sh/${name}@${encodeURIComponent(range)}/package.json`);

	if (!response.ok) {
		return undefined;
	}

	const manifest = await response.json() as { "version"?: string; "dependencies"?: Record<string, string> };

	return manifest.version === undefined ? undefined : { "version": manifest.version, "dependencies": manifest.dependencies ?? {} };
}

/** The packages a lockfile installs (npm's v2/v3 `packages`), each name once — the first, root before nested. */
export function lockedPackages(lock: { "packages"?: Record<string, { "version"?: string; "resolved"?: string; "link"?: boolean }> }): Wanted[] {
	const wanted = new Map<string, Wanted>();

	for (const [path, entry] of Object.entries(lock.packages ?? {}).toSorted(([one], [other]) => one.split("node_modules/").length - other.split("node_modules/").length)) {
		const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

		if (path !== "" && path.includes("node_modules/") && entry.version !== undefined && entry.link !== true && !wanted.has(name)) {
			wanted.set(name, { "name": name, "version": entry.version, ...entry.resolved?.startsWith("https://") === true ? { "tarball": entry.resolved } : {} });
		}
	}

	return [...wanted.values()];
}

/** Every package the project's package.jsons depend on, and theirs, resolved — each name once, the first found. */
async function resolvedPackages(manifests: { "dependencies"?: Record<string, string>; "devDependencies"?: Record<string, string> }[]): Promise<Wanted[]> {
	const wanted = new Map<string, Wanted>();
	const queue = manifests.flatMap((manifest) => Object.entries({ ...manifest.devDependencies, ...manifest.dependencies }));

	while (queue.length > 0) {
		const batch = queue.splice(0, PARALLEL * 4).filter(([name, range], index, all) => !wanted.has(name) && resolvable(range) && all.findIndex(([other]) => other === name) === index);

		for (const [index, found] of (await Promise.all(batch.map(async ([name, range]) => resolve(name, range).catch(() => undefined)))).entries()) {
			const [name] = batch[index];

			if (found !== undefined && !wanted.has(name)) {
				wanted.set(name, { "name": name, "version": found.version });
				queue.push(...Object.entries(found.dependencies));
			}
		}
	}

	return [...wanted.values()];
}

let making: Promise<void> | undefined;

/**
 * Make `.silo/baseline.json` if the workspace (at `root`) has none: the packages its package-lock.json installs — else its
 * package.jsons' dependencies, resolved — each with what its own code can do. Once a session; never over one that's there.
 * A package that can't be read is left out, and said: its calls will read as a package the baseline doesn't have.
 */
export function ensureBaseline(vscode: typeof vscodeApi, root = "/workspace"): Promise<void> {
	making ??= (async () => {
		const uri = vscode.Uri.file(`${root}/${baselinePath()}`);

		if (await Promise.resolve(vscode.workspace.fs.stat(uri)).then(() => true, () => false)) {
			return;
		}

		const read = async (file: vscodeApi.Uri): Promise<unknown> => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as unknown;
		const files = (await vscode.workspace.findFiles("**/package.json", `{**/node_modules/**,**/${SILO_DIR}/**}`)).toSorted((one, other) => one.path.length - other.path.length);
		const manifests = (await Promise.all(files.map(async (file) => read(file).catch(() => undefined)))).filter((manifest) => manifest !== undefined) as { "dependencies"?: Record<string, string>; "devDependencies"?: Record<string, string> }[];
		const lock = await read(vscode.Uri.file(`${root}/package-lock.json`)).catch(() => undefined) as Parameters<typeof lockedPackages>[0] | undefined;
		const wanted = lock?.packages === undefined ? await resolvedPackages(manifests) : lockedPackages(lock);
		const packages: Record<string, Accepted> = {};
		const unread: string[] = [];

		for (let at = 0; at < wanted.length; at += PARALLEL) {
			await Promise.all(wanted.slice(at, at + PARALLEL).map(async ({ name, version, tarball }) => {
				try {
					packages[name] = { "version": version, "caps": await capsOf(name, version, tarball) };
				} catch (error) {
					unread.push(`${name}@${version} (${error instanceof Error ? error.message : String(error)})`);
				}
			}));
		}

		// (written as silo's saveBaseline writes it — and checked again: another window may have made one meanwhile)
		if (await Promise.resolve(vscode.workspace.fs.stat(uri)).then(() => true, () => false)) {
			return;
		}

		const sorted = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));

		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ "consumer": {}, "packages": sorted }, undefined, 2) + "\n"));
		console.info(`[baseline] made ${baselinePath()}: ${Object.keys(sorted).length} packages, from ${lock?.packages === undefined ? "package.json ranges (esm.sh)" : "package-lock.json"}`);

		if (unread.length > 0) {
			console.warn(`[baseline] left out what couldn't be read — a run's calls by these will read as packages the baseline doesn't have: ${unread.join(", ")}`);
		}
	})().catch((error: unknown) => {
		making = undefined;
		console.error("[baseline] couldn't be made:", error);
	});

	return making;
}
