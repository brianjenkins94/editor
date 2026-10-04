// What instrumenting a preview costs (RUNTIME-EVIDENCE.md, the third slice: Cost): a game-like hot loop — vector
// math, property reads, `?.`, `??`, branches, small calls — run plain, instrumented for coverage, and instrumented in
// full, against the page runtime's own counting (page-evidence.ts). Prints each level's time and its ratio to plain.
//   node --import tsx test/preview-instrument-cost.mjs
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { instrument } from "../../almostnode/frameworks/instrument.ts";
import { installPageEvidence } from "../extensions/worker-pod/page-evidence.ts";

const program = `
interface Body { x: number; y: number; vx: number; vy: number; target?: { x: number; y: number } }
function step(body: Body, dt: number) {
	const target = body.target?.x ?? 0;
	if (body.x < target) { body.vx += 0.1; } else { body.vx -= 0.1; }
	body.x += body.vx * dt;
	body.y += body.vy * dt;
	return body.x > 1000 || body.y > 1000 ? 0 : 1;
}
const bodies: Body[] = [];
for (let i = 0; i < 200; i++) { bodies.push({ x: i, y: i, vx: 1, vy: 1, target: i % 2 === 0 ? { x: 500, y: 0 } : undefined }); }
let alive = 0;
for (let frame = 0; frame < FRAMES; frame++) {
	for (const body of bodies) { alive += step(body, 0.016); }
}
done(alive);
`;

const FRAMES = 2000;

function compile(level) {
	const options = { "compilerOptions": { "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ES2020 } };

	if (level === "off") {
		return ts.transpileModule(program, options).outputText;
	}

	const instrumented = instrument("/workspace/bench.ts", "oid", level);
	const output = ts.transpileModule(program, { ...options, "transformers": { "before": [instrumented.before] } }).outputText;

	return instrumented.prelude() + "\n" + output;
}

function time(level) {
	const code = compile(level);
	let result;
	const context = { "FRAMES": FRAMES, "done": (value) => { result = value; } };
	const start = performance.now();

	runInNewContext(code, level === "off" ? context : { ...context, "__evidence": installRuntime() });

	return { "ms": performance.now() - start, "result": result };
}

/** The page runtime, as a preview page has it (its listeners and timer stubbed: there's no page here). */
function installRuntime() {
	const { setInterval: realSetInterval } = globalThis;

	globalThis.addEventListener = () => undefined;
	globalThis.setInterval = () => 0;
	installPageEvidence(() => undefined);
	globalThis.setInterval = realSetInterval;

	return globalThis.__evidence;
}

const levels = ["off", "coverage", "full"];
const best = Object.fromEntries(levels.map((level) => [level, Infinity]));

for (let round = 0; round < 5; round += 1) {
	for (const level of levels) {
		best[level] = Math.min(best[level], time(level).ms);
	}
}

for (const level of levels) {
	console.log(`${level.padEnd(9)} ${best[level].toFixed(1).padStart(8)} ms   ×${(best[level] / best.off).toFixed(2)}`);
}
