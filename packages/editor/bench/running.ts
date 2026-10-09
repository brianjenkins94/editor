/**
 * RUNNING.md, step 0: what running in the debugger costs. The same programs run three ways, in Node (no browser in the
 * way): natively on almostnode (a real run today), on tsval bare, and on tsval as the debug worker runs it (coverage, the
 * profile, observed sites, the value trace). Workloads: pure computation in the program's code; data shuffled mostly by
 * built-ins; a server answering requests (its handler stepped, called from almostnode's http); and a build-like run
 * whose heavy work is in a package (native under tsval too: MODULES.md).
 *
 *   node --experimental-strip-types packages/editor/bench/running.ts [rounds]
 */
import { register } from "node:module";

register("../../almostnode/test/extensionless.mjs", import.meta.url);

const { Runtime } = await import("../../almostnode/runtime.ts");
const { VirtualFS } = await import("../../almostnode/virtual-fs.ts");
const { getServer } = await import("../../almostnode/shims/http.ts");
const { createVM, runToEnd } = await import("../../tsval/src/index.ts");

type Files = Record<string, string>;
type Mode = "native" | "tsval" | "debugger";

const PRIMES = `function isPrime(n) {
	for (let d = 2; d * d <= n; d += 1) {
		if (n % d === 0) {
			return false;
		}
	}
	return n > 1;
}
let count = 0;
for (let n = 0; n < LIMIT; n += 1) {
	if (isPrime(n)) {
		count += 1;
	}
}
module.exports = count;
`;

const WORKLOADS: Record<string, { "files": Files; "requests"?: number }> = {
	"compute (primes < 20k, the program's own loops)": { "files": { "/workspace/main.js": PRIMES.replace("LIMIT", "20000") } },
	"data (20k records through map/filter/sort/JSON — built-ins)": { "files": { "/workspace/main.js": `const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i, name: "item " + i, price: (i * 7919) % 1000 / 10 }));
const cheap = rows.filter((row) => row.price < 50).map((row) => ({ ...row, label: row.name.toUpperCase() }));
cheap.sort((a, b) => a.price - b.price || a.id - b.id);
module.exports = JSON.parse(JSON.stringify(cheap)).length;
` } },
	"server (500 requests, a small JSON handler)": { "requests": 500, "files": { "/workspace/main.js": `const http = require("http");
const items = Array.from({ length: 50 }, (_, i) => ({ id: i, total: i * 3 }));
http.createServer((request, response) => {
	const id = Number(new URL(request.url, "http://x").searchParams.get("id"));
	const found = items.filter((item) => item.id <= id).reduce((sum, item) => sum + item.total, 0);
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ id, found }));
}).listen(4100);
` } },
	"build-like (the work in a package: primes < 20k, natively)": { "files": {
		"/workspace/node_modules/heavy/package.json": JSON.stringify({ "name": "heavy", "main": "index.js" }),
		"/workspace/node_modules/heavy/index.js": `module.exports = (LIMIT) => { ${PRIMES.replace("module.exports = count;", "return count;")} };`,
		"/workspace/main.js": "const heavy = require(\"heavy\");\nconst results = [];\nfor (const limit of [5000, 10000, 20000]) {\n\tresults.push(heavy(limit));\n}\nmodule.exports = results;\n"
	} }
};

function runtimeWith(files: Files, options: ConstructorParameters<typeof Runtime>[1] = {}): InstanceType<typeof Runtime> {
	const vfs = new VirtualFS();

	for (const [path, text] of Object.entries(files)) {
		vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { "recursive": true });
		vfs.writeFileSync(path, text);
	}

	return new Runtime(vfs, { "cwd": "/workspace", "onConsole": () => undefined, ...options });
}

/** One run of `files`' main.js in `mode`, then its requests if it serves: the milliseconds each took. */
async function runOnce(files: Files, mode: Mode, requests = 0): Promise<{ "run": number; "requests": number }> {
	const started = performance.now();
	let runtime: InstanceType<typeof Runtime>;

	if (mode === "native") {
		runtime = runtimeWith(files);
		runtime.runFile("/workspace/main.js");
	} else {
		let vm: ReturnType<typeof createVM>["vm"] | undefined;

		runtime = runtimeWith(files, { "evaluateProgram": (module) => { vm!.evaluateModule(module); } });

		const loader = {
			"resolve": (specifier: string, fromDir: string) => runtime.resolve(specifier, fromDir),
			"require": (specifier: string, fromDir: string) => runtime.require(specifier, fromDir, "program"),
			"source": (filename: string) => runtime.getVFS().readFileSync(filename, "utf8") as string,
			"cached": (filename: string) => runtime.cached(filename),
			"register": (filename: string, module: unknown) => { runtime.register(filename, module as Parameters<typeof runtime.register>[1]); },
			"forget": (filename: string) => { runtime.forget(filename); }
		};
		const debugging = mode === "debugger" ? { "coverage": true, "profile": true, "observe": () => undefined, "trace": () => undefined } : {};

		// (URL isn't one of tsval's standard globals: the host's, as native has it.)
		vm = createVM(files["/workspace/main.js"]!, { "fileName": "/workspace/main.js", "modules": loader, "globals": { "URL": URL }, "eventLoop": { "pace": "fast" }, ...debugging }).vm;
		await runToEnd(vm);
	}

	const ran = performance.now() - started;

	// (A server's listen registers a tick later.)
	if (requests > 0) {
		for (let waited = 0; getServer(4100) === undefined && waited < 100; waited += 1) {
			await new Promise((resolve) => { setTimeout(resolve, 1); });
		}
	}

	const served = performance.now();

	for (let index = 0; index < requests; index += 1) {
		const server = getServer(4100) as unknown as { "handleRequest": (method: string, url: string, headers: Record<string, string>) => Promise<{ "statusCode": number }> };
		const response = await server.handleRequest("GET", `/?id=${index % 50}`, {});

		if (response.statusCode !== 200) {
			throw new Error(`request ${index}: ${response.statusCode}`);
		}
	}

	if (requests > 0) {
		(getServer(4100) as unknown as { "close": () => void }).close();
	}

	return { "run": ran, "requests": performance.now() - served };
}

const median = (values: number[]): number => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rounds = Number(process.argv[2] ?? 5);

console.log(`rounds: ${rounds} (median shown; the first, a warm-up, is dropped)\n`);

for (const [name, { files, requests = 0 }] of Object.entries(WORKLOADS)) {
	const results: Record<Mode, { "run": number; "requests": number }> = {} as never;

	for (const mode of ["native", "tsval", "debugger"] as Mode[]) {
		const samples: { "run": number; "requests": number }[] = [];

		for (let round = 0; round <= rounds; round += 1) {
			const sample = await runOnce(files, mode, requests);

			if (round > 0) {
				samples.push(sample);
			}
		}

		results[mode] = { "run": median(samples.map((sample) => sample.run)), "requests": median(samples.map((sample) => sample.requests)) };
	}

	const measure = (mode: Mode): number => (requests > 0 ? results[mode].requests : results[mode].run);
	const ms = (value: number): string => `${value.toFixed(1)}ms`;

	console.log(name + (requests > 0 ? " — the requests" : ""));
	console.log(`  native   ${ms(measure("native"))}`);
	console.log(`  tsval    ${ms(measure("tsval"))}  ×${(measure("tsval") / measure("native")).toFixed(1)}`);
	console.log(`  debugger ${ms(measure("debugger"))}  ×${(measure("debugger") / measure("native")).toFixed(1)}\n`);
}
