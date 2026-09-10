import * as assert from "node:assert/strict";

// anchor.ts and bridge.ts pull detect/reach from @brianjenkins94/util/silo. If the installed util predates those
// (they live in lib and ship with util), the import fails — skip, like the CI sweep does for such modules.
let anchorModule: typeof import("../src/anchor");
let bridgeModule: typeof import("../src/bridge");

try {
	anchorModule = await import("../src/anchor");
	bridgeModule = await import("../src/bridge");
} catch {
	console.log("silo-anchor: skipped (@brianjenkins94/util/silo/{detect,reach} not resolvable yet)");
	process.exit(0);
}

const { anchor, fingerprint, reanchor } = anchorModule;
const { align, prepare } = bridgeModule;

// ── bridge: CST nodes resolve to the expected tsc kinds and types ──
{
	const src = `const n = 1;\nfetch("https://a.test/x");\n`;
	const rows = align(src).filter((row) => row.ts !== undefined);
	const kindOf = (type: string) => rows.filter((row) => row.cst.type === type).map((row) => row.ts?.kind);

	assert.deepEqual(kindOf("CallExpression"), ["CallExpression"]);
	assert.deepEqual(kindOf("VariableDeclarator"), ["VariableDeclaration"]);
	assert.ok(kindOf("Identifier").includes("Identifier"));

	const bridge = prepare(src);
	const call = src.indexOf("fetch(");

	assert.equal(bridge.match(call, src.indexOf(";", call))?.type, "Promise<Response>");
	assert.equal(bridge.match(0, src.length)?.kind, undefined, "no single tsc node covers two statements");
	assert.equal(bridge.match(0, src.indexOf(";") + 1)?.kind, "VariableStatement");
}

// ── fingerprint: invariant under whitespace and comment edits, changed by a value edit ──
{
	const commented = `fetch("https://a.test/x"); // one`;
	const reformatted = `fetch( "https://a.test/x" )   /* two */`;
	const changed = `fetch("https://a.test/y");`;
	const fp = (src: string) => fingerprint(src, 0, src.indexOf(")") + 1);

	assert.equal(fp(commented), fp(reformatted));
	assert.notEqual(fp(commented), fp(changed));
	assert.equal(fp(commented), `fetch ( " https://a.test/x " )`);
}

// ── anchor + reanchor: identical findings land on distinct nodes; an edit re-locates or stales them ──
{
	const src = `fetch("https://a.test/x");\nfetch("https://a.test/x");\n`;
	const report = anchor(src);

	assert.equal(report.anchored.length, 2);
	assert.deepEqual(report.anchored.map((finding) => finding.cst.type), ["CallExpression", "CallExpression"]);
	assert.deepEqual(report.anchored.map((finding) => finding.type), ["Promise<Response>", "Promise<Response>"]);

	const same = reanchor(report.anchored, src);

	assert.deepEqual(same.map((row) => [row.status, row.cst?.start]), [["anchored", 0], ["anchored", 27]]);

	// a comment and a reformat above: both still anchored, at shifted offsets
	const moved = reanchor(report.anchored, `// header\n${src.replace("fetch(\"", "fetch( \"")}`);

	assert.deepEqual(moved.map((row) => row.status), ["anchored", "anchored"]);
	assert.equal(moved[0].cst?.start, 10);

	// the second call's value changes: only it goes stale
	const edited = reanchor(report.anchored, src.replace(/x"\);\n$/u, "z\");\n"));

	assert.deepEqual(edited.map((row) => row.status), ["anchored", "stale"]);

	// a finding whose node is deleted is stale, the other survives
	assert.deepEqual(reanchor(report.anchored, `fetch("https://a.test/x");\n`).map((row) => row.status), ["anchored", "stale"]);
}

console.log("silo-anchor: ok");
