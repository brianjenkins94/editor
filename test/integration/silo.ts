/**
 * Loader for the REAL static kernel (`../lib/util/silo`) — the thing tsval is the dynamic complement
 * of (ASSIGNMENT §1). silo is oxc-based and uses extensionless TS imports, which Node's strip-only
 * loader can't resolve, so it is imported through `tsx` (a devDependency of `lib`), registered only
 * for the duration of those imports. Absent `../lib` (or its node_modules), `loadSilo()` returns
 * undefined and the integration tests skip — tsval itself stays free of the dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Reach {
	capability: string;
	value: string;
	callee: string;
	safe?: boolean;
	line: number;
	column: number;
}

export interface Silo {
	/** silo's regex capability detectors over source text → the predicted set (sorted, refined). */
	detect(code: string): string[];
	/** silo's AST reach finder: literal resources at matched callsites. */
	findReach(file: string, src: string): Reach[];
	/** the call-based names per capability (the vocabulary the canary must share). */
	CALL_DETECTORS: Record<string, string[]>;
}

const LIB = path.resolve(import.meta.dirname, "../../../lib");
const SILO_DIR = path.join(LIB, "util/silo");
const TSX_API = path.join(LIB, "node_modules/tsx/dist/esm/api/index.mjs");

let cached: Promise<Silo | undefined> | undefined;

export function loadSilo(): Promise<Silo | undefined> {
	cached ??= (async () => {
		if (!fs.existsSync(path.join(SILO_DIR, "detect.ts")) || !fs.existsSync(TSX_API)) return undefined;
		const tsx = (await import(pathToFileURL(TSX_API).href)) as { register(): () => void };
		const unregister = tsx.register();
		try {
			const detect = (await import(pathToFileURL(path.join(SILO_DIR, "detect.ts")).href)) as Pick<Silo, "detect" | "CALL_DETECTORS">;
			const reach = (await import(pathToFileURL(path.join(SILO_DIR, "reach.ts")).href)) as Pick<Silo, "findReach">;
			return { detect: detect.detect, CALL_DETECTORS: detect.CALL_DETECTORS, findReach: reach.findReach };
		} finally {
			unregister();
		}
	})();
	return cached;
}
