/**
 * Bundled sample projects for the shell's LHS project picker (the pre-auth, offline source of "projects").
 *
 * The catalog lives HERE (app side, next to the VFS) rather than in the shell, so the shell only sends a project id
 * over the hub and the app resolves it to files — keeping file contents off the postMessage channel. There are no
 * bundled samples at present: `sampleList()` returns nothing and `sampleById()` resolves nothing, so the picker offers
 * only its other sources (public GitHub repos, sign-in/commit-back). The interfaces stay so the hub wiring in
 * main.tsx/shell.tsx keeps compiling and a catalog can be reintroduced later.
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

/** The metadata list the picker renders (no file contents). */
export function sampleList(): SampleInfo[] {
	return [];
}

/** Resolve a sample by id (undefined when unknown). */
export function sampleById(_id: string): Sample | undefined {
	return undefined;
}
