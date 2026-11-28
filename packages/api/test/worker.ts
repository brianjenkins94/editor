/**
 * The Worker as the tests run it: in workerd, built from wrangler.jsonc as `wrangler dev` builds it, with the test's own
 * secrets and vars. With COVERAGE=1 (the reach record, packages/editor/build/reach-record.ts) its source is counted
 * (packages/editor/build/coverage.ts) and each test's reach written once the file's done, as the editor's suites write
 * theirs (`<REACH_DIR>/packages/api/test/<file>.json`): the Worker is built from an instrumented copy of src/ kept under
 * node_modules (so its imports resolve as the original's; one per test file, made again each run), which answers
 * `/__coverage` with what it has run.
 */
import * as path from "node:path";
import { after, afterEach } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { createTestHarness } from "wrangler";

const ROOT = new URL("..", import.meta.url).pathname;
const REPO = path.resolve(ROOT, "../..");

/** Where COVERAGE=1 writes each test file's reach. */
export const REACH_DIR = process.env["REACH_DIR"] ?? path.join(fs.tmpdir(), "architecture-reach");

const ENTRY = `import worker from "./src/index.ts";
export * from "./src/index.ts";
const ran = () => {
	const files = {};
	for (const { file, statements } of globalThis.__evidence?.evidence() ?? []) {
		files[file] = statements.map(({ start, end, count }) => [...start, ...end, count]);
	}
	return files;
};
export default { ...worker, async fetch(request, env, context) {
	return new URL(request.url).pathname === "/__coverage" ? Response.json(ran()) : worker.fetch(request, env, context);
} };
`;

/** An instrumented copy of the Worker: its src/, each module counted, and a config whose main answers `/__coverage`. */
async function instrumentedCopy(): Promise<string> {
	// (by URL: the editor's build, not the API's to typecheck)
	const { instrumented } = await import(new URL("../../editor/build/coverage.ts", import.meta.url).href) as { "instrumented": (code: string, id: string) => string | undefined };
	const copy = path.join(ROOT, "node_modules", ".coverage", path.basename(process.argv[1] ?? "worker"));

	await fs.rm(copy, { "recursive": true, "force": true });

	for (const file of fs.readdirSync(path.join(ROOT, "src"), { "recursive": true }) as string[]) {
		const from = path.join(ROOT, "src", file);
		const to = path.join(copy, "src", file);

		if (fs.statSync(from).isDirectory()) {
			continue;
		}

		fs.mkdirSync(path.dirname(to), { "recursive": true });
		fs.writeFileSync(to, file.endsWith(".ts") && !file.endsWith(".d.ts")
			? instrumented(fs.readFileSync(from), from) ?? fs.readFileSync(from)
			: fs.readFileSync(from, { "encoding": null }));
	}

	fs.writeFileSync(path.join(copy, "entry.ts"), ENTRY);

	const config = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"))
		.replace("\"main\": \"src/index.ts\"", "\"main\": \"entry.ts\"")
		.replace("\"directory\": \"public\"", `"directory": ${JSON.stringify(path.join(ROOT, "public"))}`)
		.replace("\"migrations_dir\": \"migrations\"", `"migrations_dir": ${JSON.stringify(path.join(ROOT, "migrations"))}`)
		.replace("\"command\": \"node scripts/webawesome.ts\"", `"command": ${JSON.stringify(`node ${path.join(ROOT, "scripts/webawesome.ts")}`)}, "cwd": ${JSON.stringify(ROOT)}`);

	fs.writeFileSync(path.join(copy, "wrangler.jsonc"), config);

	return copy;
}

const counting = process.env["COVERAGE"] === "1" && process.env["NODE_TEST_CONTEXT"] !== undefined;
const copy = counting
	? await instrumentedCopy()
	: undefined;

export function apiWorker({ secrets, vars = {} }: { "secrets": Record<string, string>; "vars"?: Record<string, string> }) {
	const server = createTestHarness({
		"root": copy ?? ROOT,
		"workers": [
			{ "configPath": "wrangler.jsonc", "secrets": secrets, "vars": vars }
		]
	});

	if (copy !== undefined) {
		countTests(server);
	}

	return server;
}

/** Each test's reach: what the Worker ran since the test before it ended (the first test's, since it started: its
 *  modules' loading too), by statement, as the editor's suites record it. */
function countTests(server: ReturnType<typeof createTestHarness>): void {
	const reach: Record<string, Record<string, number[][]>> = {};
	let before: Record<string, number[][]> = {};
	const countsNow = async (): Promise<Record<string, number[][]>> => (await server.fetch("/__coverage").then(async (response) => response.json()).catch(() => ({}))) as Record<string, number[][]>;

	afterEach(async (test) => {
		const ran: Record<string, number[][]> = {};
		const now = await countsNow();

		for (const [file, statements] of Object.entries(now)) {
			const was = before[file];
			const these = statements.filter((statement, site) => statement[4] > (was?.[site]?.[4] ?? 0)).map((statement) => statement.slice(0, 4));

			if (these.length > 0) {
				ran[file] = these;
			}
		}

		reach[test.fullName] = ran;
		before = now;
	});
	after(() => {
		const file = path.join(REACH_DIR, path.relative(REPO, process.argv[1] ?? "") + ".json");

		fs.mkdirSync(path.dirname(file), { "recursive": true });
		fs.writeFileSync(file, JSON.stringify(reach));
	});
}
