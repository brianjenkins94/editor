/**
 * node:test's report, as silo reads it back from a CI's log (`silo test`, packages/silo/README.md decision 20): a line a
 * test, `silo:test {"file", "titles", "outcome", "ms"}`, its file from the repository's top (SILO_ROOT, else the working
 * folder) — what the spec reporter beside it doesn't say. A suite's own line isn't one: its tests are.
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=@brianjenkins94/silo/reporter --test-reporter-destination=stdout …
 */
import * as path from "node:path";

const ROOT = process.env.SILO_ROOT ?? process.cwd();

/** The line silo looks for. */
export const MARK = "silo:test ";

export default async function* reporter(source) {
	// (each file's open tests by depth, for the titles of the ones inside them)
	const open = new Map();

	for await (const event of source) {
		const { data } = event;

		if (event.type === "test:start") {
			const stack = open.get(data.file) ?? [];

			stack.length = data.nesting;
			stack.push(data.name);
			open.set(data.file, stack);
		} else if ((event.type === "test:pass" || event.type === "test:fail") && data.details?.type !== "suite") {
			const titles = [...(open.get(data.file) ?? []).slice(0, data.nesting), data.name];
			const outcome = data.skip !== undefined ? "skip" : data.todo !== undefined ? "todo" : event.type === "test:pass" ? "pass" : "fail";

			yield `${MARK}${JSON.stringify({ "file": data.file === undefined ? undefined : path.relative(ROOT, data.file).split(path.sep).join("/"), "titles": titles, "outcome": outcome, "ms": data.details?.duration_ms })}\n`;
		}
	}
}
