import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";
import { gzipSync } from "node:zlib";
import * as fs from "@brianjenkins94/util/fs";
import tar from "tar-stream";

const here = path.dirname(url.fileURLToPath(import.meta.url));

const ROOTS = ["eslint", "@brianjenkins94/util"];

const FIXTURE = {
	"tsconfig.json": JSON.stringify({ "compilerOptions": { "strict": true, "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler", "noEmit": true }, "include": ["src"] }),
	"src/probe.ts": "async function load(): Promise<number> {\n\treturn 1;\n}\n\nexport function run(): void {\n\tvar unused = 1;\n\tload();\n\tconsole.log(unused)\n}\n"
};

function packageRoot(file: string): string {
	const at = file.lastIndexOf("/node_modules/") + "/node_modules/".length;
	const [first, second] = file.slice(at).split("/");

	return file.slice(0, at) + (first.startsWith("@") ? `${first}/${second}` : first);
}

const kept = (file: string): boolean => !/\.(?:map|md|markdown)$/iu.test(file) && !(/\.d\.[cm]?ts$/u.test(file) && !/\/typescript\/lib\/lib\./u.test(file));

function filesOf(root: string): string[] {
	return fs.readdirSync(root, { "withFileTypes": true }).flatMap((entry) => {
		const full = path.join(root, entry.name);

		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : filesOf(full);
		}

		return entry.isFile() ? [full] : [];
	});
}

async function resolvePackage(name: string, from: string): Promise<string | undefined> {
	for (let dir = from; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);

		if (fs.existsSync(path.join(candidate, "package.json"))) {
			return fs.realpath(candidate);
		}
	}

	return undefined;
}

function manifestOf(root: string): { "name": string; "dependencies": string[] } {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"))) as { "name"?: string; "dependencies"?: object; "optionalDependencies"?: object; "peerDependencies"?: object };

	return { "name": manifest.name ?? path.basename(root), "dependencies": Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }) };
}

async function layOut(packages: Set<string>, roots: string[]): Promise<Map<string, string>> {
	const placed = new Map<string, string>();
	const manifests = new Map([...packages].map((root) => [root, manifestOf(root)]));
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

			if (dependency === undefined || !packages.has(dependency) || found(folder, name) === dependency) {
				continue;
			}

			place(placed.has("node_modules/" + name) ? `${folder}/node_modules/${name}` : "node_modules/" + name, dependency);
		}
	}

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
			const own = path.basename(root) === "typescript" ? [...loaded].filter((file) => file.startsWith(root + "/")) : filesOf(root).filter((file) => kept(file) || loaded.has(file));

			for (const file of own.sort()) {
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
