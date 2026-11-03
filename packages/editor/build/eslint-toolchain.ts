/**
 * The eslint worker's toolchain (extensions/eslint/worker.ts): ESLint, the preset (`@brianjenkins94/util/eslint`) and
 * everything they load — typescript-eslint and TypeScript with its lib files among it — as one gzipped tar, served beside
 * the worker (`dist/lsp/eslint-toolchain.tgz`). The worker unpacks it into its own memory and runs ESLint from it under
 * almostnode, as Node would run it: no bundling, no polyfills of our own.
 *
 * What's in it is what a real lint loads: a child Node lints a small TypeScript project with the preset and traces every
 * file it loads or reads (eslint-toolchain-trace.mjs) — and of each package it loaded from, the whole package, less what
 * nothing runs (source maps, type declarations, docs): a package may need a file the trace never read (one whose path
 * it resolves as it loads, to start as a worker later, say). TypeScript is the exception, kept to what was read: its
 * compiler API and lib files, not its compiler and server.
 *
 * Laid out as npm lays out node_modules, whatever installed them here (npm's folders on a desktop, pnpm's symlinks into
 * its store in CI — and the worker's filesystem has no symlinks): each package where Node finds it from the packages
 * that depend on it — one copy of a name at the top, another version of it under the package that needs that one.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";
import { gzipSync } from "node:zlib";
import * as fs from "@brianjenkins94/util/fs";
import tar from "tar-stream";

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** What the worker's entry loads (worker.ts), resolved from this package as it resolves them: the toolchain's roots. */
const ROOTS = ["eslint", "@brianjenkins94/util"];

/** The project the trace lints: a tsconfig (so typescript-eslint's project service, with types, is traced too) and a
 *  file with something for type-aware and plain rules alike to say. */
const FIXTURE = {
	"tsconfig.json": JSON.stringify({ "compilerOptions": { "strict": true, "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler", "noEmit": true }, "include": ["src"] }),
	"src/probe.ts": "async function load(): Promise<number> {\n\treturn 1;\n}\n\nexport function run(): void {\n\tvar unused = 1;\n\tload();\n\tconsole.log(unused)\n}\n"
};

/** The package folder a file under node_modules is in (`…/node_modules/@scope/name`, `…/node_modules/name`). */
function packageRoot(file: string): string {
	const at = file.lastIndexOf("/node_modules/") + "/node_modules/".length;
	const [first, second] = file.slice(at).split("/");

	return file.slice(0, at) + (first.startsWith("@") ? `${first}/${second}` : first);
}

/** Whether a file of a package is kept: not a source map, a type declaration (but TypeScript's lib files, which the
 *  project service reads) or a doc. */
const kept = (file: string): boolean => !/\.(?:map|md|markdown)$/iu.test(file) && !(/\.d\.[cm]?ts$/u.test(file) && !/\/typescript\/lib\/lib\./u.test(file));

/** A package's files (none in its own node_modules: each dependency is its own entry). */
function filesOf(root: string): string[] {
	return fs.readdirSync(root, { "withFileTypes": true }).flatMap((entry) => {
		const full = path.join(root, entry.name);

		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : filesOf(full);
		}

		return entry.isFile() ? [full] : [];
	});
}

/** Where Node finds package `name` from folder `from`: node_modules walked up, as a real path (pnpm's links followed). */
async function resolvePackage(name: string, from: string): Promise<string | undefined> {
	for (let dir = from; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);

		if (fs.existsSync(path.join(candidate, "package.json"))) {
			return fs.realpath(candidate);
		}
	}

	return undefined;
}

/** A package's name and what it depends on (its dependencies, optional and peer ones too), by name. */
function manifestOf(root: string): { "name": string; "dependencies": string[] } {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"))) as { "name"?: string; "dependencies"?: object; "optionalDependencies"?: object; "peerDependencies"?: object };

	return { "name": manifest.name ?? path.basename(root), "dependencies": Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }) };
}

/**
 * Where each package goes, npm's way: from the roots, breadth first, each dependency at the top (`node_modules/<name>`)
 * when that's free or already it, else under the package that needs it — so that walking node_modules up from each
 * package finds the copy it was installed against. By folder in the toolchain, each package's real folder here.
 */
async function layOut(packages: Set<string>, roots: string[]): Promise<Map<string, string>> {
	const placed = new Map<string, string>();
	const manifests = new Map([...packages].map((root) => [root, manifestOf(root)]));
	// (what's found from a folder of the layout, walking up: its node_modules, then each enclosing one's)
	const found = (from: string, name: string): string | undefined => {
		for (let dir = from; ; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/node_modules/")))) {
			const at = placed.get((dir === "" ? "" : dir + "/") + "node_modules/" + name);

			if (at !== undefined || dir === "") {
				return at;
			}
		}
	};
	const queue: [string, string][] = [];
	const place = (folder: string, root: string): void => {
		placed.set(folder, root);
		queue.push([folder, root]);
	};

	for (const root of roots) {
		place("node_modules/" + (manifests.get(root)?.name ?? path.basename(root)), root);
	}

	while (queue.length > 0) {
		const [folder, root] = queue.shift() as [string, string];

		for (const name of manifests.get(root)?.dependencies ?? []) {
			const dependency = await resolvePackage(name, root);

			// (only what the lint loaded: a dependency it never touched isn't in the toolchain)
			if (dependency === undefined || !packages.has(dependency) || found(folder, name) === dependency) {
				continue;
			}

			place(placed.has("node_modules/" + name) ? `${folder}/node_modules/${name}` : "node_modules/" + name, dependency);
		}
	}

	// (one the lint loaded that no package declares — reached some other way — at the top, where Node would find it)
	const unplaced = [...packages].filter((root) => ![...placed.values()].includes(root));

	for (const root of unplaced) {
		const folder = "node_modules/" + (manifests.get(root)?.name ?? path.basename(root));

		if (placed.has(folder)) {
			throw new Error(`eslint's toolchain: ${root} has nowhere to go (${folder} is another copy)`);
		}

		placed.set(folder, root);
	}

	return placed;
}

/** Trace a lint, and pack what it loaded into `outFile`. */
export async function eslintToolchain(outFile: string): Promise<{ "files": number; "bytes": number; "packages": number }> {
	const fixture = await fs.mkdtemp(path.join(fs.tmpdir(), "eslint-toolchain-"));

	try {
		for (const [file, text] of Object.entries(FIXTURE)) {
			await fs.mkdir(path.dirname(path.join(fixture, file)), { "recursive": true });
			fs.writeFileSync(path.join(fixture, file), text);
		}

		const tracePath = path.join(fixture, "trace.json");
		const traced = spawnSync(process.execPath, [path.join(here, "eslint-toolchain-trace.mjs"), fixture, tracePath], { "cwd": here, "encoding": "utf8" });

		if (traced.status !== 0) {
			throw new Error("tracing eslint's toolchain failed:\n" + traced.stderr);
		}

		// (by real path: pnpm's links followed, as Node's loader follows them)
		const loaded = new Set(await Promise.all((JSON.parse(fs.readFileSync(tracePath)) as string[]).filter((file) => file.includes("/node_modules/") && fs.existsSync(file) && fs.statSync(file).isFile()).map(async (file) => fs.realpath(file))));
		const packages = new Set([...loaded].map((file) => packageRoot(file)));
		const roots = await Promise.all(ROOTS.map(async (name) => resolvePackage(name, path.dirname(here))));

		if (roots.some((root) => root === undefined || !packages.has(root))) {
			throw new Error(`eslint's toolchain: ${ROOTS.join(", ")} should be among what the lint loaded`);
		}

		const layout = await layOut(packages, roots as string[]);
		const pack = tar.pack();
		const chunks: Buffer[] = [];
		let files = 0;

		pack.on("data", (chunk: unknown) => {
			chunks.push(chunk as Buffer);
		});

		const ended = new Promise<void>((resolve, reject) => {
			pack.on("end", resolve);
			pack.on("error", reject);
		});

		for (const [folder, root] of [...layout].sort(([one], [other]) => one.localeCompare(other))) {
			// (each package whole — but TypeScript, kept to what was read — less what nothing runs)
			const own = path.basename(root) === "typescript" ? [...loaded].filter((file) => file.startsWith(root + "/")) : filesOf(root).filter((file) => kept(file) || loaded.has(file));

			for (const file of own.sort()) {
				// (under a folder of its own, as an npm tarball's are under `package/`: almostnode's unpack drops it)
				pack.entry({ "name": `toolchain/${folder}/${path.relative(root, file).split(path.sep).join("/")}` }, fs.readFileSync(file, { "encoding": null }));
				files += 1;
			}
		}

		pack.finalize();
		await ended;

		const bytes = gzipSync(Buffer.concat(chunks), { "level": 9 });

		await fs.mkdir(path.dirname(outFile), { "recursive": true });
		fs.writeFileSync(outFile, bytes);

		return { "files": files, "bytes": bytes.length, "packages": layout.size };
	} finally {
		await fs.rm(fixture, { "recursive": true, "force": true });
	}
}
