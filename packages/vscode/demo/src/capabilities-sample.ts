// A sample for the capability overlay. The Capabilities tsserver plugin runs util/silo's STATIC analysis
// (`findReach`) over the file and, for every capability call whose resource is a STATIC STRING LITERAL, publishes
// a native diagnostic anchored to the call — a Warning for a dangerous capability (net / fs:write / exec / eval),
// a Suggestion otherwise (e.g. env). Hover a squiggle for the resolved resource + the checker's type.
//
// The static half captures the CONCRETE value only when it's a literal. A dynamic resource — a concatenation, a
// variable, a template with holes — is where the dynamic canary (the middle column, built next) takes over,
// running the code to observe the real pre-call value.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

// net → dangerous (Warning). The URL resolves statically to the literal.
export async function loadUser(): Promise<Response> {
	return fetch("https://api.example.com/users/42");
}

// env → not dangerous (Suggestion). The key ("API_KEY") is captured.
export const apiKey = process.env.API_KEY;

// fs:write → dangerous (Warning). The path resolves to the literal.
export async function persist(data: string): Promise<void> {
	await writeFile("/tmp/out.log", data);
}

// exec → dangerous (Warning). The command ("rm") is captured.
export function cleanup(): void {
	spawn("rm", ["-rf", "/tmp/scratch"]);
}

// Dynamic resource — static analysis can't resolve the URL (it's a concatenation), so no static value here.
// This is exactly the case the dynamic canary lights up with the real pre-call value at runtime.
export async function loadProfile(id: string): Promise<Response> {
	return fetch("https://api.example.com/users/" + id);
}
