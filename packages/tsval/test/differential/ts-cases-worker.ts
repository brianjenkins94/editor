/**
 * Child-process entry for the TypeScript-cases runner: cases run here, isolated by the process
 * boundary. Compiler tests were never meant to run — one spreads an infinite iterator into an array
 * literal, which grows an array past V8's maximum and aborts the process (a fatal error no heap
 * limit or worker thread can contain; Node's and tsval's sides alike). Such a case must take down a
 * child, not the report.
 */
import fs from "node:fs";
import path from "node:path";
import { parseCase } from "./ts-cases-corpus.ts";
import { runTsCase } from "./ts-cases-run.ts";

let lateRejections = 0;
process.on("unhandledRejection", () => void lateRejections++); // guest async work that fails after its case ended

process.on("message", async (message: { seq: number; root: string; id: string }) => {
	const file = path.join(message.root, "tests/cases", message.id);
	let outcome;
	try {
		outcome = await runTsCase(parseCase(message.id, fs.readFileSync(file, "utf8")));
	} catch (error) {
		outcome = { kind: "mismatch" as const, reason: `runner error: ${String((error as Error)?.message ?? error).slice(0, 120)}` };
	}
	process.send?.({ seq: message.seq, outcome, lateRejections });
});
