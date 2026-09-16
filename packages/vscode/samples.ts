/**
 * Bundled sample projects for the shell's LHS project picker (the pre-auth, offline source of "projects").
 *
 * These ship in the app bundle — zero network, no GitHub — and are the first source the picker offers; public
 * GitHub repos (Trees API + raw.githubusercontent) become a second source later, and sign-in/commit-back later
 * still. The catalog lives HERE (app side, next to the VFS) rather than in the shell, so the shell only sends a
 * project id over the hub and the app resolves it to files — keeping file contents off the postMessage channel.
 *
 * Files mount UNDER the existing `/workspace` root (namespaced by sample id), so the workspace's managed
 * `tsconfig.json` applies and the in-browser TS server type-checks them. Opening a sample writes its files and
 * focuses its entry; see workbench-entry.tsx `openProject`.
 */

/** One file in a sample project. Matches the snapshot file shape (path + contents). */
export interface SampleFile { "path": string; "contents": string }

/** A bundled sample project the picker can open. */
export interface Sample {
	"id": string;
	"name": string;
	"description": string;
	"files": SampleFile[];
	/** Files (absolute paths) to open + focus once the sample is written. */
	"openEditors": string[];
}

/** Metadata-only view sent to the shell over the hub (no file contents). */
export interface SampleInfo { "id": string; "name": string; "description": string }

const HELLO = `// A tiny starter. Edit me — saves flow back to the host over the pane bus.
function greet(name: string): string {
	return \`Hello, \${name}!\`;
}

for (const who of ["world", "editor", "capabilities"]) {
	console.log(greet(who));
}
`;

const CAPABILITIES = `// A sample for the capability IDE. Run it under the tsval debugger (F5) and a gated capability call
// HARD-STOPS at its line — the enforce end of the pipeline (detect → resolve → surface → enforce).
import { spawn } from "node:child_process";

// STATIC: a literal URL — flagged inline even though this isn't called at load.
export async function health(): Promise<Response> {
	return fetch("https://api.example.com/health");
}

// DYNAMIC: computed resources the static half can't resolve — the canary resolves them at runtime.
const region = "us-east";
const version = "v2";
export const config = fetch("https://" + region + ".api.example.com/" + version + "/config");

const tool = ["n", "p", "m"].join(""); // "npm"
spawn(tool, ["run", "build"]);
`;

const FIZZBUZZ = `// Classic FizzBuzz — a self-contained loop to poke at with the debugger.
function fizzbuzz(n: number): string {
	if (n % 15 === 0) { return "FizzBuzz"; }
	if (n % 3 === 0) { return "Fizz"; }
	if (n % 5 === 0) { return "Buzz"; }

	return String(n);
}

for (let i = 1; i <= 20; i += 1) {
	console.log(fizzbuzz(i));
}
`;

export const SAMPLES: Sample[] = [
	{
		"id": "hello",
		"name": "Hello, TypeScript",
		"description": "A minimal starter — one function, a loop, a console.",
		"files": [{ "path": "/workspace/samples/hello/main.ts", "contents": HELLO }],
		"openEditors": ["/workspace/samples/hello/main.ts"]
	},
	{
		"id": "capabilities",
		"name": "Capability demo",
		"description": "fetch + spawn with computed resources — the capability IDE's showcase.",
		"files": [{ "path": "/workspace/samples/capabilities/capabilities.ts", "contents": CAPABILITIES }],
		"openEditors": ["/workspace/samples/capabilities/capabilities.ts"]
	},
	{
		"id": "fizzbuzz",
		"name": "FizzBuzz",
		"description": "A tiny loop to step through in the debugger.",
		"files": [{ "path": "/workspace/samples/fizzbuzz/fizzbuzz.ts", "contents": FIZZBUZZ }],
		"openEditors": ["/workspace/samples/fizzbuzz/fizzbuzz.ts"]
	}
];

/** The metadata list the picker renders (no file contents). */
export function sampleList(): SampleInfo[] {
	return SAMPLES.map(({ id, name, description }) => ({ "id": id, "name": name, "description": description }));
}

/** Resolve a sample by id (undefined when unknown). */
export function sampleById(id: string): Sample | undefined {
	return SAMPLES.find((sample) => sample.id === id);
}
