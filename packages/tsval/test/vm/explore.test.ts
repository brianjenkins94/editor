import assert from "node:assert";
import { test } from "node:test";
import { explore, runToEnd } from "../../src/explore.ts";
import { createVM } from "../../src/interpret.ts";

/** A program run on an event loop with host calls that answer at once (a debugger's stand-ins do), following
 *  `schedule`: what it logged, or how it threw, and the choices it made. */
async function run(source: string, schedule: number[] = [], choose?: (count: number) => number): Promise<{ "outcome": unknown[]; "choices": ReturnType<typeof createVM>["vm"]["choices"] }> {
	const lines: unknown[] = [];
	const answer = (name: string) => Object.defineProperty(async () => name, "name", { "value": name });
	const globals = { "log": (value: unknown) => { lines.push(value); }, "fetchA": answer("fetchA"), "fetchB": answer("fetchB"), "fetchData": answer("fetchData") };
	const { vm } = createVM(source, { "globals": globals, "eventLoop": { "now": 0, "seed": 1, "pace": "fast", "schedule": schedule, ...choose === undefined ? {} : { "choose": (candidates) => choose(candidates.length) } } });
	try {
		await runToEnd(vm);
	} catch (error) {
		lines.push(`threw ${(error as Error).message}`);
	}

	return { "outcome": lines, "choices": vm.choices };
}

test("results are events: by default in the order they were asked for, whatever else", async () => {
	const source = "fetchA().then(() => log('A')); fetchB().then(() => log('B')); log('asked');";

	assert.deepStrictEqual((await run(source)).outcome, ["asked", "A", "B"]);
	assert.deepStrictEqual((await run(source, [], (count) => count - 1)).outcome, ["asked", "B", "A"], "chosen the other way");
});

test("a result is the program's only once it's delivered — even to Promise.race", async () => {
	const source = "Promise.race([fetchData(), new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))]).then(log);";
	const choices = (await run(source)).choices;

	assert.deepStrictEqual(choices.map(({ candidates }) => candidates.map(({ kind }) => kind)), [["result", "timer"]]);
	assert.deepStrictEqual((await run(source)).outcome, ["fetchData"]);
	assert.deepStrictEqual((await run(source, [1])).outcome, ["timeout"], "the timer first: the request was slower than its timeout");
});

test("explore: every way the races can go, each outcome with a schedule that reaches it again", async () => {
	const source = [
		"let last;",
		"fetchA().then(() => { last = 'A'; });",
		"fetchB().then(() => { last = 'B'; });",
		"setTimeout(() => log(last === undefined ? 'nothing yet' : last + ' last'), 10);"
	].join("\n");
	const explored = await explore((schedule) => run(source, schedule));

	assert.ok(explored.complete);
	assert.deepStrictEqual(explored.outcomes.map(({ outcome }) => outcome).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [["A last"], ["B last"], ["nothing yet"]]);

	for (const { outcome, schedule } of explored.outcomes) {
		assert.deepStrictEqual((await run(source, schedule)).outcome, outcome, `schedule ${JSON.stringify(schedule)} runs the same way`);
	}
});

test("explore: a program with no choice to make has one outcome, in one run", async () => {
	const explored = await explore((schedule) => run("fetchA().then(log); log('asked');", schedule));

	assert.deepStrictEqual(explored.outcomes.map(({ outcome }) => outcome), [["asked", "fetchA"]]);
	assert.strictEqual(explored.runs, 1);
});

test("explore: a result before or after a timer is a choice — the log's order shows it", async () => {
	const explored = await explore((schedule) => run("fetchA().then(log); setTimeout(() => log('later'), 5);", schedule));

	assert.deepStrictEqual(explored.outcomes.map(({ outcome }) => outcome).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [["fetchA", "later"], ["later", "fetchA"]]);
});

test("explore: a crash only one ordering reaches is found, with its schedule", async () => {
	const source = [
		"let user;",
		"fetchA().then(() => { user = { name: 'ada' }; });",
		"await fetchB();",
		"log(user.name);"
	].join("\n");
	const explored = await explore((schedule) => run(source, schedule));
	const crash = explored.outcomes.find(({ outcome }) => String(outcome[0]).startsWith("threw"));

	assert.ok(crash !== undefined, "the order where B's result comes first");
	assert.deepStrictEqual(explored.outcomes.find((each) => each !== crash)?.outcome, ["ada"]);
	assert.deepStrictEqual((await run(source, crash.schedule)).outcome, crash.outcome);
});

test("explore: maxRuns cuts it short, and says so", async () => {
	const source = "for (let i = 0; i < 5; i += 1) fetchA().then(() => log(i));";
	const explored = await explore((schedule) => run(source, schedule), { "maxRuns": 10 });

	assert.strictEqual(explored.runs, 10);
	assert.strictEqual(explored.complete, false);
});
