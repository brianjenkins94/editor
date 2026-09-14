// A sample for the capability IDE. Two halves work together:
//
// STATIC (squiggles + Problems) — the Capabilities tsserver plugin runs util/silo's `findReach` and flags every
// capability call whose resource is a STATIC STRING LITERAL. Hover a squiggle for the resolved value + type.
//
// DYNAMIC (the "Capability calls" panel in the Explorer) — the canary RUNS this module in the tsval interpreter
// and reports the CONCRETE resource each capability call was actually invoked with, including the computed ones
// the static half can't resolve. Capability callables are inert stand-ins, so running it does nothing real.

import { spawn } from "node:child_process";

// STATIC: a literal URL, so this is flagged inline even though `health` is never called at module load — the
// point of the static half. (It won't appear in the dynamic panel: the canary only sees calls that actually run.)
export async function health(): Promise<Response> {
	return fetch("https://api.example.com/health"); // net → Warning, resolved value in the hover
}

// DYNAMIC: these run at module load with COMPUTED resources the static half leaves unresolved. The canary
// resolves them at runtime — watch the panel show the concrete URL and command.
const region = "us-east";
const version = "v2";
export const config = fetch("https://" + region + ".api.example.com/" + version + "/config");

const tool = ["n", "p", "m"].join(""); // "npm"
spawn(tool, ["run", "build"]);
